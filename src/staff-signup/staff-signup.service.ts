import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationStatus, Prisma } from '@prisma/client';
import {
  HQ_SHARING_CONSENT_VERSION,
  hqSharingAgreedOf,
} from '../admin-scope/hq-sharing';
import {
  AuthSessionService,
  INVALID_SESSION_MESSAGE,
} from '../auth-session/auth-session.service';
import { AccountAuthService } from '../auth/account-auth.service';
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
import {
  PENDING_TERMS_SELECT,
  pendingTermsOf,
  transitionMany,
} from '../contracts/contract-status';
import { ageOn, lockPeople } from '../contracts/contracts.service';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import type { InvitationCheckResponseDto } from './dto/invitation-check.response.dto';
import type { InvitationLookupDto } from './dto/invitation-lookup.dto';
import type {
  AcceptMyInvitationDto,
  AcceptMyInvitationResponseDto,
  MyInvitationListResponseDto,
} from './dto/my-invitation.dto';
import type {
  StaffSignupDto,
  StaffSignupResponseDto,
} from './dto/staff-signup.dto';
import {
  asksHqSharingConsentAt,
  hqSharingConsentRecordOf,
  warnStaleHqSharingVersion,
} from './hq-sharing-consent';
import { sameName } from '../contracts/identity-match';

/** 번호 · 코드가 맞는 초대가 없다 — 어느 쪽이 틀렸는지, 그 번호로 초대가 있는지 알리지 않는다(JOIN-7) */
export const CODE_MISMATCH = '휴대전화번호나 초대 코드를 다시 확인해 주세요.';
/** 찾은 초대가 끝났다(기한 · 다시 보냄 · 번호 변경 · 퇴직 · 가입 불가) — 링크와 코드가 똑같이 무효다 */
export const INVITATION_ENDED =
  '초대가 만료되었거나 더 쓸 수 없습니다. 근무지에 다시 초대해 달라고 요청해 주세요.';
/** 운영 정책 ACC-22 문구 */
export const UNDER_AGE =
  '만 19세 미만은 WHALE ERP로 근로계약과 출퇴근을 관리하지 않습니다. 근무지 관리자에게 알려 주세요.';
/** 같은 번호로 5회 틀리면 30분 잠근다(JOIN-7) */
export const CODE_LOCK_MS = 30 * 60 * 1000;
export const CODE_LOCKED =
  '초대 코드 입력이 잠겼습니다. 30분 뒤 다시 시도하거나, 근무지 관리자에게 재발송을 요청해 주세요.';
/** 만 19세 미만 운영 알림 템플릿(20261021103042_team3_staff_signup) */
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
/** 그런 초대가 없다 — 로그인한 직원의 근무지 더하기에서는 남의 초대 · 가입 초대가 아닌 것도 이것이다(상태를 드러내지 않는다) */
export const invitationNotFound = () =>
  notFound('INVITATION_NOT_FOUND', INVITATION_ENDED);
const alreadyJoined = () =>
  conflict(
    'INVITATION_ALREADY_JOINED',
    '이미 가입을 마친 초대입니다. 로그인해 주세요.',
  );
/** 로그인한 직원의 근무지 더하기에서 이미 수락한 초대 — 같은 code 이고 「로그인해 주세요」만 뺀다(이미 로그인해 있다) */
const alreadyAdded = () =>
  conflict(
    'INVITATION_ALREADY_JOINED',
    '이미 가입을 마친 초대입니다. 이 근무지는 계정에 이어져 있습니다.',
  );
/** 그 번호로 계정이 있다 — 로그인한 뒤 앱 안에서 근무지를 더한다(WHALEERP-603 · 144) */
const accountExists = () =>
  conflict('ACCOUNT_EXISTS', '이미 계정이 있습니다. 로그인해 주세요.');

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
      accountId: true,
      // 초대 확인이 보이는 고용 형태 — 함께 온 계약의 것(없으면 레코드, pendingTermsOf). 재계약 초대면 레코드는 옛 조건이다
      ...PENDING_TERMS_SELECT,
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
  | {
      kind: 'joined';
      accountId: number;
      email: string;
      realName: string;
      hqSharingConsentRecorded: boolean | null;
    }
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
 * - 로그인한 직원은 계정의 번호로 온 가입 초대 목록에서 골라 그 근무지를 더한다(WHALEERP-603, 2026-10-20 김민식 — 두 점포에서
 *   같은 때 가입 초대를 받은 경우. 2026-10-28 초대 코드 · 링크 입력 대신 목록으로). 초대 id 로 찾되 초대의 번호가 계정 번호와
 *   같아야 한다 — 남의 초대를 내 계정에 잇지 못하게. 계정 정보 · 인적사항 · 약관은 다시 받지 않고 나이도 보지 않는다(기존
 *   계정, WHALEERP-137).
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
      employmentType: pendingTermsOf(staffMember, staffMember.contracts[0])
        .employmentType,
      expiresAt: invitation.expiresAt,
      phone: staffMember.phone,
      asksHqSharingConsent: asksHqSharingConsentAt(store.storeTypeCode),
    };
  }

  /** 가입(가이드 ③) — 마치면 로그인된 상태다(가이드 ④) */
  async signup(dto: StaffSignupDto): Promise<StaffSignupResponseDto> {
    const weak = validateNewPassword(dto.password, dto.email);
    if (weak) throw new BadRequestException(weak);
    const today = kstToday().toISOString().slice(0, 10);
    // 오늘 뒤 날짜는 잘못 넣은 것이다 — 만 19세 미만으로 보고 초대를 끝내지 않게 먼저 막는다(api #81 리뷰)
    if (dto.birthDate > today)
      throw badRequest(
        'BIRTH_DATE_IN_FUTURE',
        '생년월일을 다시 확인해 주세요.',
      );
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
        // 직원 행도 초대 · 계약보다 먼저 잠근다 — 퇴직 확정(직원 → 초대 → 계약)과 같은 순서라 서로 기다려 교착하지 않는다.
        // 잠근 뒤 번호를 다시 읽어, 그사이 근로계약 수정으로 번호가 바뀌었으면 옛 번호로 잇지 않는다(api #81 재리뷰)
        const [locked] = await tx.$queryRaw<{ phone: string }[]>`
          SELECT phone FROM staff_members WHERE staff_member_id = ${staffMember.staffMemberId} FOR UPDATE`;
        if (locked?.phone !== staffMember.phone)
          throw notFound('INVITATION_ENDED', INVITATION_ENDED);
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

        // 보인 문구 버전이 지금과 다르면 가입은 마치고 동의만 남기지 않는다(ATT-30 v253)
        const hqSharingConsentRecorded = hqSharingConsentRecordOf(
          asksHqSharingConsentAt(store.storeTypeCode),
          dto,
        );
        const account = await tx.account.create({
          data: {
            email: dto.email,
            passwordHash,
            realName: dto.name,
            birthDate: new Date(`${dto.birthDate}T00:00:00.000Z`),
            phone: staffMember.phone,
            gender: dto.gender,
            isForeigner: dto.isForeigner ?? false,
            zipCode: dto.zipCode,
            address: dto.address,
            addressDetail: dto.addressDetail || null,
            status: 'JOINED',
            ...(hqSharingConsentRecorded
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
        return { kind: 'joined', ...account, hqSharingConsentRecorded };
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw conflict(
          'ACCOUNT_EMAIL_TAKEN',
          '이미 가입한 이메일입니다. 다른 이메일을 쓰거나 로그인해 주세요.',
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

    warnStaleHqSharingVersion(
      this.logger,
      '가입',
      outcome.accountId,
      dto,
      outcome.hqSharingConsentRecorded,
    );
    // 가입이 커밋된 뒤 접속 상태를 연다 — 여기서 실패해도 가입은 끝났고, 직원은 로그인 화면에서 들어온다
    const session = await this.sessions.issue({
      accountId: outcome.accountId,
      deviceIdentifier: dto.deviceIdentifier,
    });
    return {
      ...(await this.accountAuth.loginResponseOf(
        {
          accountId: outcome.accountId,
          email: outcome.email,
          realName: outcome.realName,
          status: 'JOINED',
        },
        session,
      )),
      hqSharingConsentRecorded: outcome.hqSharingConsentRecorded,
    };
  }

  /**
   * 로그인한 직원에게 온 가입 초대(WHALEERP-603, 2026-10-28) — 계정 번호로 나간 살아 있는 가입 초대 · 재초대(보냄 · 기한 안 ·
   * 아직 계정 없는 레코드, 가입 확인과 같은 기준)를 보낸 때 최근 순으로. 점포를 찾지 못한 초대는 뺀다. 본사 제공 동의는
   * 직영이 아니고 계정이 받아 주는 문구 버전에 아직 동의하지 않았을 때만 묻는다(hqSharingAgreedOf).
   */
  async listForAccount(
    accountId: number,
  ): Promise<MyInvitationListResponseDto> {
    const account = await this.accountOf(this.prisma, accountId);
    const rows = await this.prisma.invitation.findMany({
      where: {
        invitationType: { in: ['SIGNUP', 'REINVITE'] },
        status: 'SENT',
        expiresAt: { gt: new Date() },
        staffMember: { phone: account.phone, accountId: null },
      },
      select: {
        invitationId: true,
        sentAt: true,
        expiresAt: true,
        staffMember: {
          select: { storeId: true, name: true, ...PENDING_TERMS_SELECT },
        },
      },
      orderBy: [{ sentAt: 'desc' }, { invitationId: 'desc' }],
    });
    // 번호가 같아도 근로계약서 이름이 계정 이름과 다르면 이 계정에 온 초대로 보지 않는다(sameName)
    const mine = rows.filter((r) =>
      sameName(r.staffMember.name, account.realName),
    );
    if (mine.length === 0) return { items: [], total: 0 };
    // 직원 레코드의 store_id 는 1팀 점포를 가리키지만 Prisma 관계가 없다(팀 경계) — 따로 한 번에 읽는다
    const stores = await this.prisma.store.findMany({
      where: {
        storeId: { in: [...new Set(mine.map((r) => r.staffMember.storeId))] },
      },
      select: { storeId: true, name: true, storeTypeCode: true },
    });
    const storeById = new Map(stores.map((st) => [st.storeId, st]));
    const items = mine.flatMap((r) => {
      const store = storeById.get(r.staffMember.storeId);
      if (!store) return [];
      // 고용 형태 · 직무는 함께 온 아직 시작 전 계약의 것, 없으면 레코드(가입 초대 확인 · 소속 추가 확인과 같다, pendingTermsOf)
      const terms = pendingTermsOf(r.staffMember, r.staffMember.contracts[0]);
      return [
        {
          invitationId: r.invitationId,
          storeName: store.name,
          employmentType: terms.employmentType,
          jobTitle: terms.jobTitle,
          sentAt: r.sentAt,
          expiresAt: r.expiresAt,
          asksHqSharingConsent:
            asksHqSharingConsentAt(store.storeTypeCode) &&
            !hqSharingAgreedOf(account),
        },
      ];
    });
    return { items, total: items.length };
  }

  /**
   * 근무지 더하기(WHALEERP-603) — 목록에서 고른 초대로, 한 트랜잭션으로 초대 수락 · 그 직원 레코드를 이 계정에 잇기(가입
   * 완료) · 발송 대기 계약 → 서명 대기. 가맹 점포이고 계정이 아직 동의하지 않았는데 동의를 보냈으면 계정에 동의를 남긴다.
   */
  async acceptForAccount(
    accountId: number,
    invitationId: number,
    dto: AcceptMyInvitationDto,
  ): Promise<AcceptMyInvitationResponseDto> {
    const { phone } = await this.accountOf(this.prisma, accountId);
    const result = await this.prisma.$transaction(async (tx) => {
      // 가입 · 근로계약 저장 · 재발송과 같은 순서로 번호부터 잡는다(api #81 리뷰) — 근무지 더하기와 재발송이 교착하지 않게
      await lockPeople(tx, [phone]);
      // 계정 행도 잠그고 읽는다 — 옛 문구 버전 동의를 다시 쓰는 사이 내 정보에서 철회하면(MyConsentService 도 이 행을 잠근다)
      // 철회가 덮여 사라진다(api #183 리뷰)
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      const now = new Date();
      const account = await this.accountOf(tx, accountId);
      const { invitation, store } = await this.accountInvitation(
        tx,
        account,
        invitationId,
        now,
      );
      const { staffMemberId } = invitation.staffMember;
      // 직원 행도 초대 · 계약보다 먼저 잠근다 — 퇴직 확정(직원 → 초대 → 계약)과 같은 순서라 서로 기다려 교착하지 않는다.
      // 잠근 뒤 번호 · 이름 · 점포를 다시 읽어, 그사이 근로계약 수정으로 바뀌었으면 잇지 않는다(가입과 같다, api #81 3차 리뷰 · 이름은
      // api #180 리뷰 · 점포는 응답의 storeId · storeName 이 잇는 레코드와 맞게 api #195 리뷰)
      const [locked] = await tx.$queryRaw<
        { phone: string; name: string; store_id: number }[]
      >`
        SELECT phone, name, store_id FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR UPDATE`;
      if (
        locked?.phone !== account.phone ||
        !sameName(locked.name, account.realName) ||
        locked.store_id !== invitation.staffMember.storeId
      )
        throw notFound('INVITATION_ENDED', INVITATION_ENDED);
      // 같은 초대로 동시에 더하면 뒤에 온 쪽은 바뀐 초대를 다시 읽어 0건이다 — 까닭에 맞게 답한다(가입과 같다)
      const accepted = await tx.invitation.updateMany({
        where: { invitationId: invitation.invitationId, status: 'SENT' },
        data: { status: 'ACCEPTED', respondedAt: now },
      });
      if (accepted.count === 0)
        throw await this.endedOrJoined(
          tx,
          invitation.invitationId,
          alreadyAdded,
        );
      // 보인 문구 버전이 지금과 다르면 근무지는 더하고 동의만 남기지 않는다(ATT-30 v253)
      const hqSharingConsentRecorded = hqSharingConsentRecordOf(
        asksHqSharingConsentAt(store.storeTypeCode) &&
          !hqSharingAgreedOf(account),
        dto,
      );
      if (hqSharingConsentRecorded)
        // 철회했던 계정이 다시 동의하면 철회 시각을 지운다 — 동의 중에는 철회 시각이 없다(accounts_hq_sharing_consent_fields)
        await tx.account.update({
          where: { accountId },
          data: {
            isHqSharingConsented: true,
            hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
            hqSharingAgreedAt: now,
            hqSharingWithdrawnAt: null,
          },
        });
      const linked = await tx.staffMember.updateMany({
        where: { staffMemberId, accountId: null },
        data: { accountId, joinStatus: 'JOINED', candidateAccountId: null },
      });
      if (linked.count === 0) throw alreadyAdded();
      await transitionMany(
        tx,
        { staffMemberId },
        'PENDING_SEND',
        'PENDING_SIGNATURE',
        'STAFF',
      );
      return {
        staffMemberId,
        storeId: invitation.staffMember.storeId,
        storeName: store.name,
        hqSharingConsentRecorded,
      };
    });
    warnStaleHqSharingVersion(
      this.logger,
      '근무지 더하기',
      accountId,
      dto,
      result.hqSharingConsentRecorded,
    );
    return result;
  }

  /** 로그인한 계정 — 가드가 접속을 확인한 뒤 탈퇴했을 수 있다 */
  private async accountOf(db: Db, accountId: number) {
    const account = await db.account.findUnique({
      where: { accountId },
      select: {
        phone: true,
        realName: true,
        status: true,
        isHqSharingConsented: true,
        hqSharingConsentVersion: true,
      },
    });
    if (!account || account.status === 'WITHDRAWN')
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    return account;
  }

  /**
   * 로그인한 직원이 고른 초대(id)를 찾는다. 없거나 · 가입 초대 · 재초대가 아니거나 · 초대의 번호가 계정 번호와 다르거나 · 근로계약서
   * 이름이 계정 이름과 다르면(sameName) 404 INVITATION_NOT_FOUND — 번호 · 이름을 상태보다 먼저 봐 남의 초대가 수락됐는지 끝났는지
   * 드러나지 않는다. 내 초대가 수락됐으면 409
   * INVITATION_ALREADY_JOINED, 살아 있지 않으면(보냄이 아님 · 기한 지남 · 레코드에 이미 계정) 404 INVITATION_ENDED.
   */
  private async accountInvitation(
    db: Db,
    { phone, realName }: { phone: string; realName: string },
    invitationId: number,
    now: Date,
  ): Promise<LiveInvitation> {
    const invitation = await db.invitation.findUnique({
      where: { invitationId },
      select: { ...INVITATION_SELECT, invitationType: true },
    });
    if (
      !invitation ||
      (invitation.invitationType !== 'SIGNUP' &&
        invitation.invitationType !== 'REINVITE') ||
      invitation.staffMember.phone !== phone ||
      !sameName(invitation.staffMember.name, realName)
    )
      throw invitationNotFound();
    if (invitation.status === 'ACCEPTED') throw alreadyAdded();
    if (
      invitation.status !== 'SENT' ||
      invitation.expiresAt <= now ||
      invitation.staffMember.accountId !== null
    )
      throw notFound('INVITATION_ENDED', INVITATION_ENDED);
    const store = await db.store.findUnique({
      where: { storeId: invitation.staffMember.storeId },
      select: { name: true, storeTypeCode: true },
    });
    if (!store) throw notFound('INVITATION_ENDED', INVITATION_ENDED);
    return { invitation, store };
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
        '초대 링크의 토큰, 또는 휴대전화번호와 초대 코드를 함께 보내 주세요.',
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
      // isSucceeded 는 「여기서부터 실패를 다시 센다」인 행에만 true — 살아 있는 초대에 맞은 코드와 재발송 해제(ContractDeliveryService)뿐이다.
      // 발송 되돌리기가 이 표시에서 멈추므로, 상태만 옮겨 적는 행은 (0, 없음)이어도 false 로 둔다(api #81 4차 리뷰)
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
  private async endedOrJoined(
    db: Db,
    invitationId: number,
    joined: () => Error = alreadyJoined,
  ) {
    const now = await db.invitation.findUnique({
      where: { invitationId },
      select: { status: true },
    });
    return now?.status === 'ACCEPTED'
      ? joined()
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
