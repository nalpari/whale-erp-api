import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationStatus, Prisma } from '@prisma/client';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { AccountAuthService } from '../auth/account-auth.service';
import type { LoginResponseDto } from '../auth/dto/login.response.dto';
import {
  AttemptState,
  CLEARED_ATTEMPT_STATE,
  isLocked,
  registerFailure,
} from '../auth/attempt-lock';
import { hashPassword, hashToken } from '../auth/password';
import { invitationCodePhoneKeyOf } from '../auth/phone-key';
import { validateNewPassword } from '../auth/password-policy';
import { hashInvitationCode } from '../contracts/contract-delivery.service';
import { transitionMany } from '../contracts/contract-status';
import { ageOn, lockPeople } from '../contracts/contracts.service';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import type { InvitationCheckResponseDto } from './dto/invitation-check.response.dto';
import type { InvitationLookupDto } from './dto/invitation-lookup.dto';
import type { StaffSignupDto } from './dto/staff-signup.dto';
import {
  asksHqSharingConsentAt,
  HQ_SHARING_CONSENT_VERSION,
} from './hq-sharing-consent';

/** 번호 · 코드가 맞는 초대가 없다 — 어느 쪽이 틀렸는지, 그 번호로 초대가 있는지 알리지 않는다(JOIN-7) */
export const CODE_MISMATCH = '휴대전화번호나 초대 코드를 다시 확인해 주세요';
/** 찾은 초대가 끝났다(기한 · 다시 보냄 · 번호 변경 · 퇴직 · 가입 불가) — 링크와 코드가 똑같이 무효다 */
export const INVITATION_ENDED =
  '초대가 만료되었거나 더 쓸 수 없습니다. 근무지에 다시 초대해 달라고 요청해 주세요';
/** 운영 정책 ACC-22 문구 */
export const UNDER_AGE =
  '만 19세 미만은 WHALE ERP로 근로계약과 출퇴근을 관리하지 않습니다. 근무지 관리자에게 알려 주세요.';
/** 같은 번호로 5회 틀리면 30분 잠근다(JOIN-7) */
export const CODE_LOCK_MS = 30 * 60 * 1000;
export const CODE_LOCKED =
  '초대 코드 입력이 잠겼습니다. 30분 뒤 다시 시도하거나, 근무지 관리자에게 재발송을 요청해 주세요';
/** 만 19세 미만 운영 알림 템플릿(20261020144610_team3_staff_signup) */
export const UNDER_AGE_TEMPLATE = 'NTF_SIGNUP_UNDER_AGE';

const conflict = (code: string, message: string) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code,
    message,
  });
const notFound = (code: string, message: string) =>
  new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    error: 'Not Found',
    code,
    message,
  });
const badRequest = (code: string, message: string) =>
  new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code,
    message,
  });
const alreadyJoined = () =>
  conflict(
    'INVITATION_ALREADY_JOINED',
    '이미 가입을 마친 초대입니다. 로그인해 주세요',
  );
/** 그 번호로 계정이 있다 — 로그인한 뒤 앱 안에서 근무지를 더한다(WHALEERP-603 · 144) */
const accountExists = () =>
  conflict('ACCOUNT_EXISTS', '이미 계정이 있습니다. 로그인해 주세요');

type Db = PrismaService | Prisma.TransactionClient;

const INVITATION_SELECT = {
  invitationId: true,
  status: true,
  expiresAt: true,
  staffMember: {
    select: {
      staffMemberId: true,
      storeId: true,
      name: true,
      phone: true,
      employmentType: true,
      accountId: true,
    },
  },
} as const satisfies Prisma.InvitationSelect;

type FoundInvitation = Prisma.InvitationGetPayload<{
  select: typeof INVITATION_SELECT;
}>;

type LiveInvitation = {
  invitation: FoundInvitation;
  store: { name: string; storeTypeCode: string };
};

/** 트랜잭션 안에서 정하고 밖에서 처리하는 결과 — 안에서 던지면 「가입 불가」 기록까지 되돌아간다 */
type SignupOutcome =
  | { kind: 'joined'; accountId: number; email: string; realName: string }
  | {
      kind: 'under_age';
      invitationId: number;
      staffMemberId: number;
      name: string;
      store: string;
    };

/**
 * 직원 앱 진입 · 가입(WHALEERP-601 · 141 · 142, 진입 · 가입 화면 가이드 JOIN-7 · 2026-10-20 김민식 — 가이드를 모두 기준으로).
 *
 * - 초대는 링크의 토큰(sha256 → invitation_token) 또는 휴대전화번호 + 초대 코드(HMAC → invitation_code_hash, 그 초대의
 *   직원 레코드 번호가 같아야)로 찾는다. 둘 다 맞아야 열린다.
 * - 확인은 근무지 · 고용 형태 · 유효 기간과 화면이 채울 번호만 준다. 그 번호로 계정이 있으면 409 ACCOUNT_EXISTS —
 *   로그인한 뒤 앱에서 근무지를 더한다(WHALEERP-603).
 * - 가입은 한 트랜잭션으로 초대 수락 · 계정 생성 · 레코드 연결(가입 완료) · 발송 대기 계약 → 서명 대기 · 접속 상태를 만든다.
 *   계정 번호는 초대(근로계약서)의 번호다. 만 19세 미만이면 계정을 만들지 않고 초대를 「가입 불가」로 두며, 커밋 뒤 그
 *   점포 관리자에게 운영 알림을 보낸다(ACC-22).
 *
 * - 번호 + 코드는 같은 번호로 5회 틀리면 30분 잠근다(JOIN-7, `invitation_code_attempts`). 초대가 없는 번호도 같은 기준으로
 *   세어 잠금 여부로 초대가 있는지 드러나지 않는다. 관리자가 그 번호로 다시 보내면 풀린다(ContractDeliveryService). 링크
 *   토큰은 32바이트라 대입 대상이 아니어서 세지 않는다.
 */
@Injectable()
export class StaffSignupService {
  private readonly logger = new Logger(StaffSignupService.name);
  private readonly codeSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionService,
    private readonly accountAuth: AccountAuthService,
    private readonly ops: OpsNotificationService,
    config: ConfigService,
  ) {
    // AuthModule 이 길이까지 검사하는 값이라 비어 있으면 api 가 뜨지 않는다 — 여기서는 비었을 때만 막는다
    const secret = config.get<string>('JWT_SECRET');
    if (!secret)
      throw new Error('JWT_SECRET 이 없어 초대 코드를 확인할 수 없습니다');
    this.codeSecret = secret;
  }

  /** 초대 확인(가이드 ①·②) — 링크로 열었거나 번호 · 코드를 넣었을 때 */
  async check(
    lookup: InvitationLookupDto,
  ): Promise<InvitationCheckResponseDto> {
    await this.guardCode(lookup);
    const { invitation, store } = await this.liveInvitation(
      this.prisma,
      lookup,
      new Date(),
    );
    const { staffMember } = invitation;
    if (await this.hasAccount(this.prisma, staffMember.phone))
      throw accountExists();
    return {
      storeName: store.name,
      employmentType: staffMember.employmentType,
      expiresAt: invitation.expiresAt,
      phone: staffMember.phone,
      asksHqSharingConsent: asksHqSharingConsentAt(store.storeTypeCode),
    };
  }

  /** 가입(가이드 ③) — 마치면 로그인된 상태다(가이드 ④) */
  async signup(dto: StaffSignupDto): Promise<LoginResponseDto> {
    const weak = validateNewPassword(dto.password, dto.email);
    if (weak) throw new BadRequestException(weak);
    const today = kstToday().toISOString().slice(0, 10);
    // 오늘 뒤 날짜는 잘못 넣은 것이다 — 만 19세 미만으로 보고 초대를 끝내지 않게 먼저 막는다(api #81 리뷰)
    if (dto.birthDate > today)
      throw badRequest('BIRTH_DATE_IN_FUTURE', '생년월일을 다시 확인해 주세요');
    // 입력 형식을 본 뒤에 코드를 센다 — 형식 오류로 실패 횟수가 쌓이지 않게
    await this.guardCode(dto);
    const underAge = ageOn(dto.birthDate, today) < 19;
    // scrypt 는 트랜잭션 밖에서 — 그동안 연결을 잡고 있지 않게
    const passwordHash = underAge ? '' : await hashPassword(dto.password);

    let outcome: SignupOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const { invitation, store } = await this.liveInvitation(tx, dto, now);
        const { staffMember } = invitation;
        // 근로계약 저장 · 재발송과 같은 순서(번호 → 계약 → 초대)로 잡는다 — 같은 번호로 동시에 가입해 계정이 둘 생기거나,
        // 가입과 재발송이 서로 행을 기다려 교착하지 않게(api #81 리뷰). 잡은 뒤에 계정 유무를 본다
        await lockPeople(tx, [staffMember.phone]);
        if (await this.hasAccount(tx, staffMember.phone)) throw accountExists();

        // 같은 초대로 동시에 가입하면 뒤에 온 쪽은 바뀐 초대를 다시 읽어 0건이다
        const status: InvitationStatus = underAge
          ? 'REJECTED_UNDER_AGE'
          : 'ACCEPTED';
        const answered = await tx.invitation.updateMany({
          where: { invitationId: invitation.invitationId, status: 'SENT' },
          data: { status, respondedAt: now },
        });
        if (answered.count === 0)
          throw await this.endedOrJoined(tx, invitation.invitationId);
        // 계정을 만들지 않는다. 생년월일은 어디에도 남기지 않는다(ACC-22)
        if (underAge)
          return {
            kind: 'under_age',
            invitationId: invitation.invitationId,
            staffMemberId: staffMember.staffMemberId,
            name: staffMember.name,
            store: store.name,
          };

        const consented =
          asksHqSharingConsentAt(store.storeTypeCode) &&
          dto.hqSharingConsented === true;
        const account = await tx.account.create({
          data: {
            email: dto.email,
            passwordHash,
            realName: dto.name,
            birthDate: new Date(`${dto.birthDate}T00:00:00.000Z`),
            phone: staffMember.phone,
            gender: dto.gender ?? null,
            isForeigner: dto.isForeigner ?? false,
            zipCode: dto.zipCode,
            address: dto.address,
            addressDetail: dto.addressDetail || null,
            status: 'JOINED',
            ...(consented
              ? {
                  isHqSharingConsented: true,
                  hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
                  hqSharingAgreedAt: now,
                }
              : {}),
          },
          select: { accountId: true, email: true, realName: true },
        });
        const linked = await tx.staffMember.updateMany({
          where: { staffMemberId: staffMember.staffMemberId, accountId: null },
          data: {
            accountId: account.accountId,
            joinStatus: 'JOINED',
            candidateAccountId: null,
          },
        });
        if (linked.count === 0) throw alreadyJoined();
        // 가입을 기다리던 근로계약서는 서명 대기로 — 가입 직후 홈의 날인 요청(가이드 ④). 앱 알림은 아직 없다
        await transitionMany(
          tx,
          { staffMemberId: staffMember.staffMemberId },
          'PENDING_SEND',
          'PENDING_SIGNATURE',
          'STAFF',
        );
        return { kind: 'joined', ...account };
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw conflict(
          'ACCOUNT_EMAIL_TAKEN',
          '이미 가입한 이메일입니다. 다른 이메일을 쓰거나 로그인해 주세요',
        );
      throw e;
    }

    if (outcome.kind === 'under_age') {
      await this.notifyUnderAge(outcome);
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'SIGNUP_UNDER_AGE',
        message: UNDER_AGE,
      });
    }

    // 가입이 커밋된 뒤 접속 상태를 연다 — 여기서 실패해도 가입은 끝났고, 직원은 로그인 화면에서 들어온다
    const session = await this.sessions.issue({
      accountId: outcome.accountId,
      deviceIdentifier: dto.deviceIdentifier,
    });
    return this.accountAuth.loginResponseOf(
      {
        accountId: outcome.accountId,
        email: outcome.email,
        realName: outcome.realName,
        status: 'JOINED',
      },
      session,
    );
  }

  /**
   * 토큰 또는 번호 + 코드로 살아 있는 가입 초대(보냄 · 기한 안 · 아직 계정 없는 레코드)를 찾는다.
   * - 둘 다 없거나 둘 다 있으면 400.
   * - 맞는 초대가 없으면 404 INVITATION_NOT_FOUND(번호 · 코드면 CODE_MISMATCH 문구).
   * - 맞는 초대 가운데 수락된 것이 있으면 409 INVITATION_ALREADY_JOINED, 아니면 끝난 초대라 404 INVITATION_ENDED.
   * 기한이 지났는데 배치가 아직 만료로 바꾸지 않은 초대도 끝난 것으로 본다.
   */
  private async liveInvitation(
    db: Db,
    lookup: InvitationLookupDto,
    now: Date,
  ): Promise<LiveInvitation> {
    const byToken = lookup.token !== undefined;
    const byCode = lookup.phone !== undefined || lookup.code !== undefined;
    if (byToken === byCode || (byCode && (!lookup.phone || !lookup.code)))
      throw new BadRequestException(
        '초대 링크의 토큰, 또는 휴대전화번호와 초대 코드를 함께 보내 주세요',
      );

    const rows = await db.invitation.findMany({
      where: {
        invitationType: { in: ['SIGNUP', 'REINVITE'] },
        ...(byToken
          ? { invitationToken: hashToken(lookup.token as string) }
          : {
              invitationCodeHash: hashInvitationCode(
                lookup.code as string,
                this.codeSecret,
              ),
              staffMember: { phone: lookup.phone },
            }),
      },
      select: INVITATION_SELECT,
      orderBy: { sentAt: 'desc' },
    });
    const invitation = rows.find(
      (r) =>
        r.status === 'SENT' &&
        r.expiresAt > now &&
        r.staffMember.accountId === null,
    );
    if (!invitation) {
      if (rows.length === 0)
        throw notFound(
          'INVITATION_NOT_FOUND',
          byToken ? INVITATION_ENDED : CODE_MISMATCH,
        );
      if (rows.some((r) => r.status === 'ACCEPTED')) throw alreadyJoined();
      throw notFound('INVITATION_ENDED', INVITATION_ENDED);
    }
    const store = await db.store.findUnique({
      where: { storeId: invitation.staffMember.storeId },
      select: { name: true, storeTypeCode: true },
    });
    if (!store) throw notFound('INVITATION_ENDED', INVITATION_ENDED);
    return { invitation, store };
  }

  /**
   * 번호 + 코드 입력 잠금(JOIN-7). 잠겨 있으면 429(해제 시각과 함께), 그 번호 · 코드에 맞는 가입 초대가 하나도 없으면 실패로
   * 세고 404 — 5번째면 30분 잠그고 429. 맞는 초대가 있으면(상태와 상관없이) 실패를 지운다. 기록은 따로 커밋한다 — 뒤의 업무
   * 트랜잭션이 되돌아가도 실패 횟수는 남는다. 토큰으로 찾으면 아무것도 하지 않는다.
   */
  private async guardCode(lookup: InvitationLookupDto): Promise<void> {
    const { phone, code } = lookup;
    if (!phone || !code || lookup.token !== undefined) return;
    const phoneKey = invitationCodePhoneKeyOf(this.codeSecret, phone);
    const outcome = await this.prisma.$transaction(async (tx) => {
      // 같은 번호의 요청을 한 줄로 세운다 — 병렬 요청이 같은 마지막 기록을 읽어 5회를 넘기지 않게(이메일 찾기와 같다)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phoneKey}))`;
      const now = new Date();
      const last = await tx.invitationCodeAttempt.findFirst({
        where: { phoneKey },
        orderBy: { invitationCodeAttemptId: 'desc' },
        select: { failedCount: true, lockExpiresAt: true },
      });
      const state: AttemptState = last ?? CLEARED_ATTEMPT_STATE;
      const record = (isSucceeded: boolean, next: AttemptState) =>
        tx.invitationCodeAttempt.create({
          data: {
            phoneKey,
            isSucceeded,
            failedCount: next.failedCount,
            lockExpiresAt: next.lockExpiresAt,
            attemptedAt: now,
          },
        });
      // 막힌 동안의 시도는 남기되 세지 않는다 — 세면 남의 번호를 끝없이 막아 둘 수 있다
      if (isLocked(state, now)) {
        await record(false, state);
        return { kind: 'locked' as const, lockExpiresAt: state.lockExpiresAt };
      }
      const matched = await tx.invitation.findMany({
        where: {
          invitationType: { in: ['SIGNUP', 'REINVITE'] },
          invitationCodeHash: hashInvitationCode(code, this.codeSecret),
          staffMember: { phone },
        },
        select: { status: true, expiresAt: true },
      });
      // 살아 있는 초대가 맞을 때만 실패를 지운다 — 끝난 옛 코드로는 지우지 못한다(api #81 리뷰). 끝난 초대가 맞으면 세지도
      // 지우지도 않고 뒤에서 「끝남 · 가입 마침」으로 답한다
      if (matched.some((m) => m.status === 'SENT' && m.expiresAt > now)) {
        await record(true, CLEARED_ATTEMPT_STATE);
        return { kind: 'matched' as const };
      }
      if (matched.length > 0) {
        await record(false, state);
        return { kind: 'matched' as const };
      }
      const next = registerFailure(state, now, CODE_LOCK_MS);
      await record(false, next);
      if (!isLocked(next, now)) return { kind: 'mismatch' as const };
      // 남의 번호를 맞혀 보는 신호일 수 있어 로그로도 남긴다 — 번호 원문 대신 키 앞부분으로
      this.logger.warn(
        `초대 코드 5회 실패로 번호를 막았다 phoneKey=${phoneKey.slice(0, 8)}`,
      );
      return { kind: 'locked' as const, lockExpiresAt: next.lockExpiresAt };
    });
    if (outcome.kind === 'mismatch')
      throw notFound('INVITATION_NOT_FOUND', CODE_MISMATCH);
    if (outcome.kind === 'locked')
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'INVITATION_CODE_LOCKED',
          message: CODE_LOCKED,
          lockExpiresAt: outcome.lockExpiresAt,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  /**
   * 조건을 건 수락이 0건이면 그사이 초대가 바뀐 것이다 — 다른 가입이 먼저 수락했으면 409(로그인으로), 재발송 · 번호 변경 ·
   * 퇴직 · 대체로 끝났으면 404 INVITATION_ENDED. 계정이 없는 사람을 로그인으로 보내지 않게(api #81 리뷰)
   */
  private async endedOrJoined(db: Db, invitationId: number) {
    const now = await db.invitation.findUnique({
      where: { invitationId },
      select: { status: true },
    });
    return now?.status === 'ACCEPTED'
      ? alreadyJoined()
      : notFound('INVITATION_ENDED', INVITATION_ENDED);
  }

  /** 그 번호로 쓰는 계정이 있는가(탈퇴 계정은 빼고) — 휴대전화번호는 계정의 신원 기준이다 */
  private async hasAccount(db: Db, phone: string): Promise<boolean> {
    return (
      (await db.account.count({
        where: { phone, status: { not: 'WITHDRAWN' } },
      })) > 0
    );
  }

  /** 만 19세 미만으로 가입하지 못했다 — 그 점포 관리자에게. 실패해도 던지지 않는다(운영 알림 공통 규칙) */
  private async notifyUnderAge(
    o: Extract<SignupOutcome, { kind: 'under_age' }>,
  ): Promise<void> {
    const recipients = await storeManagers(this.prisma, o.staffMemberId).catch(
      (e: unknown) => {
        this.logger.error(`가입 불가 알림 받는 사람을 찾지 못함: ${String(e)}`);
        return [];
      },
    );
    await this.ops.notify({
      templateCode: UNDER_AGE_TEMPLATE,
      variables: { 직원이름: o.name, 근무지: o.store },
      related: { type: 'STAFF_MEMBER', id: o.staffMemberId },
      // 초대 하나에 한 번 — 가입 불가로 바뀐 초대는 다시 쓸 수 없다
      eventKey: `invitation:${o.invitationId}`,
      recipients,
    });
  }
}
