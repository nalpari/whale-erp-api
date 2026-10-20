import {
  BadRequestException,
  ConflictException,
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
import { hashPassword, hashToken } from '../auth/password';
import { validateNewPassword } from '../auth/password-policy';
import { hashInvitationCode } from '../contracts/contract-delivery.service';
import { transitionMany } from '../contracts/contract-status';
import { ageOn } from '../contracts/contracts.service';
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
 * TODO(WHALEERP-601): 같은 번호 5회 · 30분 잠금(JOIN-7) — 기록 표 invitation_code_attempts 가 논리 ERD 에 들어오면
 * 번호 + 코드가 맞지 않을 때(`CODE_MISMATCH`) 세고, 재발송하면 그 번호 잠금을 푼다. 그 전에는 IP 요청 제한만 받는다.
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
    const underAge =
      ageOn(dto.birthDate, kstToday().toISOString().slice(0, 10)) < 19;
    // scrypt 는 트랜잭션 밖에서 — 그동안 연결을 잡고 있지 않게
    const passwordHash = underAge ? '' : await hashPassword(dto.password);

    let outcome: SignupOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const { invitation, store } = await this.liveInvitation(tx, dto, now);
        const { staffMember } = invitation;
        if (await this.hasAccount(tx, staffMember.phone)) throw accountExists();

        // 같은 초대로 동시에 가입하면 뒤에 온 쪽은 바뀐 초대를 다시 읽어 0건이다
        const status: InvitationStatus = underAge
          ? 'REJECTED_UNDER_AGE'
          : 'ACCEPTED';
        const answered = await tx.invitation.updateMany({
          where: { invitationId: invitation.invitationId, status: 'SENT' },
          data: { status, respondedAt: now },
        });
        if (answered.count === 0) throw alreadyJoined();
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
