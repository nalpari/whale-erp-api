import { createHmac, randomBytes, randomInt } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContractStatus, EmploymentType, Prisma } from '@prisma/client';
import { AlimtalkService, isMobilePhone } from '../alimtalk/alimtalk.service';
import { BizppurioError } from '../alimtalk/bizppurio.client';
import { hashToken } from '../auth/password';
import { invitationCodePhoneKeyOf } from '../auth/phone-key';
import {
  affiliationLinkOf,
  inviteLinkOf,
  readStaffAppUrl,
} from '../auth/staff-app-url';
import { errorKind } from '../common/error-kind';
import { employmentTypeLabel } from '../enums/employment-type-label';
import { isProduction } from '../config/profile';
import {
  OPTIONAL_MAIL_SERVICE,
  type OptionalMailService,
} from '../mail/mail.module';
import { findSendableTemplate } from '../notification-templates/find-template';
import { noticeStaff } from '../notifications/staff-notice';
import { PrismaService } from '../prisma/prisma.service';
import {
  lockContract,
  lockStaffMember,
  pendingTermsOf,
} from './contract-status';

/** 가입 초대 알림톡 템플릿(근무지 · 초대코드 · 링크=초대 링크). 카카오 템플릿 WHALE_INVITE_01 */
export const INVITATION_TEMPLATE = 'TALK_STAFF_INVITATION';
/**
 * 소속 추가 확인 요청 알림톡 · 메일(사업자 · 근무지 · 고용형태 · 링크=직원 앱 요청 화면, WHALEERP-130 · 2026-10-26 재영). 카카오
 * 템플릿 WHALE_AFFILIATION_01 은 등록 · 검수 전이라 알림톡이 거절되고 대체 문자로 간다(가입 초대와 같다). 메일은 계정의 이메일로 —
 * 알림톡과 따로 가고 실패해도 저장을 되돌리지 않는다.
 */
export const AFFILIATION_TEMPLATE = 'TALK_STAFF_AFFILIATION_REQUEST';
export const AFFILIATION_MAIL_TEMPLATE = 'EMAIL_STAFF_AFFILIATION_REQUEST';
/** 초대 코드 · 서명 기한 — 보낸 날로부터 30일(WHALEERP-136, 물리 ERD sign_deadline_at) */
export const SEND_VALID_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 초대 코드 — 대문자 영문 · 숫자 8자리, 헷갈리는 0 · O · 1 · I 는 뺀다(JOIN-7, 2026-10-19 재영 — 진입 · 가입 화면 가이드).
 * 앱을 직접 연 직원이 휴대전화번호와 함께 넣어 가입을 시작한다(WHALEERP-141). 관리자에게도 보이지 않아 DB 에는 되돌릴 수
 * 없는 값만 둔다.
 */
export const INVITATION_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITATION_CODE_LENGTH = 8;

export function newInvitationCode(): string {
  let code = '';
  for (let i = 0; i < INVITATION_CODE_LENGTH; i++)
    code += INVITATION_CODE_CHARS[randomInt(INVITATION_CODE_CHARS.length)];
  return code;
}

/**
 * DB(invitations.invitation_code_hash)에 두는 값. 8자리는 경우의 수(32⁸ ≈ 1조)가 작아 그냥 해시면 행이 새는 순간 모두
 * 대입해 풀린다 — 서버 비밀값(JWT_SECRET)을 섞은 HMAC-SHA256 으로 둔다. 입력은 대문자로 맞춰 본다.
 */
export const hashInvitationCode = (code: string, secret: string) =>
  createHmac('sha256', secret)
    .update(`invitation-code:${code.trim().toUpperCase()}`)
    .digest('hex');

/**
 * 초대 링크의 토큰(32바이트, base64url 43자). DB(invitations.invitation_token)에는 sha256 만 둔다 — 행이 새어도 링크를
 * 만들 수 없게. 토큰은 무작위 바이트라 대입 대상이 아니어서 비밀값을 섞지 않는다(갱신 토큰 · 재설정 링크와 같다).
 */
export function newInvitationToken(): { token: string; stored: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, stored: hashToken(token) };
}

type DraftAction = Prisma.ContractUpdateManyMutationInput['draftAction'];

/**
 * 근로계약을 받을 길. 가입하지 않았고 그 번호로 계정도 없으면 가입 초대 알림톡(INVITE), 계정은 있고 이 점포 레코드에 아직 잇지
 * 않은 번호(소속 추가 확인 · 복귀 확인)면 소속 추가 확인 요청 알림톡 · 메일(AFFILIATION, WHALEERP-130 · 2026-10-26 재영), 가입한
 * 직원이면 앱 알림(APP — 직원 알림 근로계약서 발송, #259)이다. 판별값이 없는 옛 계약의 가입 전 직원도 APP 이지만 받을 계정이
 * 없어 아무것도 나가지 않는다.
 */
export const channelOf = (
  joined: boolean,
  draftAction: DraftAction,
): 'INVITE' | 'AFFILIATION' | 'APP' => {
  if (joined) return 'APP';
  if (draftAction === 'SIGNUP_INVITE') return 'INVITE';
  if (draftAction === 'AFFILIATION_CONFIRM' || draftAction === 'RETURN_CONFIRM')
    return 'AFFILIATION';
  return 'APP';
};

/**
 * 보낸 뒤의 상태(2026-10-19 재영 정정). 가입 초대 · 소속 추가 확인 요청은 발송 대기(요청은 나갔고 직원의 가입 · 수락을 기다림 —
 * 수락하면 서명 대기, 2026-10-26 재영), 앱으로 받는 직원은 곧바로 서명 대기다.
 */
export const deliveredStatusOf = (
  joined: boolean,
  draftAction: DraftAction,
): ContractStatus =>
  channelOf(joined, draftAction) === 'APP'
    ? 'PENDING_SIGNATURE'
    : 'PENDING_SEND';

/** 보내기 직전의 계약 · 직원 값. 알림톡이 확실히 나가지 않았을 때 이 값으로 되돌린다. */
export type DeliveryBefore = {
  /** 새로 만든 계약이면 null */
  status: ContractStatus | null;
  sentAt: Date | null;
  signDeadlineAt: Date | null;
  draftAction: DraftAction;
  staffMemberId: number;
  staffMember: { joinStatus: string; candidateAccountId: number | null };
};

export type DeliveryInput = {
  contractId: number;
  storeId: number;
  phone: string;
  joined: boolean;
  draftAction: DraftAction;
  before: DeliveryBefore;
  /** 이 저장이 상태를 바꿔 이력을 한 줄 썼는가(되돌릴 때 그 줄을 지운다) */
  statusChanged: boolean;
  /** 번호가 바뀌었는가 — 옛 번호로 나간 초대 · 옛 번호의 초대 유형 · 후보 계정은 되살리지 않는다 */
  phoneChanged: boolean;
  /** 이 저장이 진행 중 계약을 대체(종료)했는가 — 무효로 한 앞 초대에 그 계약 때 나간 것이 섞여 되살리지 않는다 */
  replacedContracts: boolean;
};

/**
 * dispatch 결과 — true 보냈거나 보낼 것이 없음, false 그사이 다른 요청이 초대를 무효로 해 보내지 않음(지금 상태를 다시 읽는다),
 * 'ANSWERED' 그사이 직원이 답해 보내지 않음(답으로 바뀐 상태 · 기한을 다시 읽는다)
 */
export type DispatchResult = boolean | 'ANSWERED';

/** 커밋 뒤 보낼 가입 초대 · 소속 추가 확인 요청. 앱 알림(APP)은 보낼 것이 없어 null 이다. */
export type PendingInvite = DeliveryInput & {
  kind: 'INVITE' | 'AFFILIATION';
  /** 알림톡에 싣는 초대 코드 원문 — DB 에는 hashInvitationCode 값만. 소속 추가 확인 요청은 코드가 없어 null */
  code: string | null;
  /** 초대 링크의 토큰 원문 — DB 에는 sha256 만. 소속 추가 확인 요청은 null */
  token: string | null;
  invitationId: number;
  /** 이 발송이 쌓은 초대 코드 입력 잠금 해제 행 — 되돌릴 때 지운다. 소속 추가 확인 요청은 null */
  unlockAttemptId: number | null;
  /** 소속 추가 확인 요청에만 — 알림톡 · 메일 변수와 받을 이메일(계정에 없으면 null) */
  affiliation: {
    bpName: string;
    employmentType: string;
    email: string | null;
  } | null;
  historyId: number | null;
  expired: number[];
  storeName: string;
  now: Date;
};

/** 알림톡이 확실히 나가지 않은 실패인가 — 비즈뿌리오 오류가 아니면 요청 전 검사, 코드가 있으면 거절, 토큰 단계면 보내지 않음 */
function notSent(e: unknown): boolean {
  if (!(e instanceof BizppurioError)) return true;
  return e.code !== undefined || e.path === '/v1/token';
}

/**
 * 근로계약 보내기(WHALEERP-136, 2026-10-19 재영 정정 — 저장하면 곧바로 보낸다). 초안 저장 · 수정 요청 계약 고침 · 날인
 * 전 당사자 정보 수정 · 재발송이 모두 같은 길로 보낸다.
 *
 * - `prepare` 는 저장 트랜잭션 안에서 쓴다 — 서명 기한(30일) · 발송 일시를 잡고, 앞서 나간 초대는 모두 무효(EXPIRED)로
 *   한다(번호를 고치거나 다시 보내면 옛 코드 · 링크는 쓸 수 없다). 가입 초대면 새 초대(코드 · 링크 토큰은 해시로만)를 만들고 직원을
 *   초대 발송으로 둔다. 상태는 호출부가 `deliveredStatusOf` 로 정해 바꾼다.
 * - `dispatch` 는 커밋 뒤에 가입 초대 알림톡을 보낸다 — 알림톡은 롤백이 없어서다(공통 모듈 규칙). 확실히 나가지
 *   않았으면 보내기 직전으로 되돌려 502 SEND_FAILED, 메시지 요청 뒤 응답이 끊겼으면 되돌리지 않고 502 SEND_UNCONFIRMED.
 *
 * 초대 코드는 알림톡 본문에 싣는다. 초대 링크(STAFF_APP_URL 의 `/invite#token=…`)는 버튼 변수인데 공통 모듈이 아직 버튼을
 * 보내지 않아 대체 문자로만 간다. 바뀐 본문은 카카오 재검수 전이라 알림톡이 거절될 수도 있다 — 카카오 재검수와 버튼 발송이
 * 들어오기 전까지는 대체 문자 발신번호가 없으면 쓰기 전에 막는다(api #74 리뷰).
 */
@Injectable()
export class ContractDeliveryService {
  private readonly logger = new Logger(ContractDeliveryService.name);
  private readonly appUrl: string | null;
  private readonly codeSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alimtalk: AlimtalkService,
    config: ConfigService,
    // 소속 추가 확인 요청 메일 — MAIL_* 가 없으면 null 이고 메일만 건너뛴다(알림톡은 나간다)
    @Optional()
    @Inject(OPTIONAL_MAIL_SERVICE)
    private readonly mail: OptionalMailService = null,
  ) {
    this.appUrl = readStaffAppUrl(
      config.get<string>('STAFF_APP_URL'),
      isProduction(),
    );
    // AuthModule 이 길이까지 검사하는 값이라 비어 있으면 api 가 뜨지 않는다 — 여기서는 비었을 때만 막는다
    const secret = config.get<string>('JWT_SECRET');
    if (!secret)
      throw new Error('JWT_SECRET 이 없어 초대 코드를 저장할 수 없습니다');
    this.codeSecret = secret;
  }

  /**
   * 가입 초대를 보낼 수 있는가 — 직원 앱 주소(초대 링크) · 대체 문자 발신번호(503), 휴대폰 번호(409 SEND_PHONE_NOT_MOBILE), 켜진
   * 템플릿(503). 저장 트랜잭션 안에서 부른다 — 던지면 저장째 되돌아가 「보내지 않았는데 보낸 상태」가 남지 않는다.
   */
  private async assertCanInvite(
    tx: Prisma.TransactionClient,
    phone: string,
    kind: 'INVITE' | 'AFFILIATION',
  ): Promise<void> {
    const what = kind === 'INVITE' ? '가입 초대' : '소속 추가 확인 요청';
    if (!this.appUrl)
      throw new ServiceUnavailableException(
        `직원 앱 주소(STAFF_APP_URL)가 없어 ${what} 링크를 보낼 수 없습니다`,
      );
    // 링크는 알림톡 버튼 변수에만 있는데 버튼을 아직 보내지 않고, 바뀐 본문은 카카오 재검수 전이다 — 대체 문자가 없으면
    // 직원에게 닿을 길이 없는데 화면은 보낸 상태가 된다(api #59 · #74 리뷰).
    if (!this.alimtalk.hasSmsFallback())
      throw new ServiceUnavailableException(
        `대체 문자 발신번호(BIZPPURIO_SMS_FROM)가 없어 ${what}를 보낼 수 없습니다`,
      );
    // 유선번호는 계약서에는 저장되지만 알림톡이 받지 않는다
    if (!isMobilePhone(phone))
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'SEND_PHONE_NOT_MOBILE',
        message: `휴대폰 번호가 아니라 ${what} 알림톡을 보낼 수 없습니다. 휴대전화번호를 고쳐 주세요`,
      });
    const template =
      kind === 'INVITE' ? INVITATION_TEMPLATE : AFFILIATION_TEMPLATE;
    await findSendableTemplate(tx, template, 'ALIMTALK').catch((e: unknown) => {
      this.logger.error(`${what} 템플릿을 쓸 수 없음: ${String(e)}`);
      throw new ServiceUnavailableException(
        `${what} 알림톡 템플릿이 없거나 꺼져 있어 보낼 수 없습니다`,
      );
    });
  }

  /**
   * 저장 트랜잭션 안에서 보낼 준비를 한다(계약 행을 잠근 뒤 · 상태를 바꾼 뒤에 부른다). 가입 초대면 커밋 뒤 보낼 것을
   * 돌려주고, 앱 알림이면 null 이다.
   */
  async prepare(
    tx: Prisma.TransactionClient,
    input: DeliveryInput,
    now: Date,
  ): Promise<PendingInvite | null> {
    const channel = channelOf(input.joined, input.draftAction);
    if (channel !== 'APP') await this.assertCanInvite(tx, input.phone, channel);
    const { staffMemberId } = input.before;
    const deadline = new Date(now.getTime() + SEND_VALID_MS);

    // 앞서 나간 초대는 모두 무효 — 링크는 마지막 것 하나만 쓴다(번호를 고치면 옛 번호로 나간 초대도 무효, 2026-10-19 재영)
    const previous = await tx.invitation.findMany({
      where: { staffMemberId, status: 'SENT' },
      select: { invitationId: true },
    });
    if (previous.length)
      await tx.invitation.updateMany({
        where: { invitationId: { in: previous.map((p) => p.invitationId) } },
        data: { status: 'EXPIRED' },
      });
    const sent = await tx.contract.update({
      where: { contractId: input.contractId },
      // 소속 추가 확인 요청이 알릴 고용 형태 · 직무 — 이 계약의 것(pendingTermsOf)
      select: { employmentType: true, jobTitle: true },
      data: {
        sentAt: now,
        // 소속 추가 확인 요청은 날인 기한을 아직 세지 않는다 — 직원이 수락한 때부터 30일이다(2026-10-26 재영). 발송 대기라 만료
        // 배치(서명 대기만 본다)에도 걸리지 않고, 요청(초대)만 30일 뒤 만료된다
        signDeadlineAt: channel === 'AFFILIATION' ? null : deadline,
        draftAction: input.draftAction,
        // 앞서 보낸 적이 있으면 재발송이다(재발송 · 고쳐 다시 보냄, WHALEERP-328) — 나가지 않아 되돌리면 함께 뺀다(undo)
        ...(input.before.sentAt !== null && {
          resendCount: { increment: 1 },
        }),
      },
    });
    if (channel === 'APP') {
      if (input.joined) await this.noticeSent(tx, input, deadline);
      return null;
    }
    if (channel === 'AFFILIATION')
      return this.prepareAffiliation(tx, input, now, deadline, previous, sent);

    const hadAny = await tx.invitation.count({ where: { staffMemberId } });
    const code = newInvitationCode();
    const link = newInvitationToken();
    const invitation = await tx.invitation.create({
      data: {
        staffMemberId,
        invitationType: hadAny ? 'REINVITE' : 'SIGNUP',
        invitationToken: link.stored,
        invitationCodeHash: hashInvitationCode(code, this.codeSecret),
        channel: 'ALIMTALK',
        sentAt: now,
        expiresAt: deadline,
        status: 'SENT',
      },
      select: { invitationId: true },
    });
    // 그 번호의 초대 코드 입력 잠금을 푼다 — 실패 0 행을 쌓는다(JOIN-7, 2026-10-20 김민식: 재발송하면 그 번호 잠금 해제).
    // 입력 쪽(StaffSignupService.guardCode)과 같은 번호 키로 줄을 서 그 사이에 실패가 끼지 않게 한다(api #81 리뷰)
    const phoneKey = invitationCodePhoneKeyOf(this.codeSecret, input.phone);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phoneKey}))`;
    const unlock = await tx.invitationCodeAttempt.create({
      // isSucceeded 로 「여기서부터 0」인 행(입력 성공과 같다)임을 표시한다 — 끝난 초대가 맞아 직전 상태를 옮겨 적은 (0, 없음)
      // 행과 구별해, 되돌리기가 다른 재발송의 해제 · 성공에서만 멈추게 한다(api #81 4차 리뷰). 잠금 판정은 이 칸을 보지 않는다
      data: {
        phoneKey,
        isSucceeded: true,
        failedCount: 0,
        lockExpiresAt: null,
        attemptedAt: now,
      },
      select: { invitationCodeAttemptId: true },
    });
    if (input.before.staffMember.joinStatus === 'DRAFT')
      await tx.staffMember.update({
        where: { staffMemberId },
        data: { joinStatus: 'INVITED', candidateAccountId: null },
      });
    // 되돌릴 때 이 저장이 쓴 상태 이력 한 줄을 지운다 — 일어나지 않은 발송이 이력에 남지 않게
    const historyId = input.statusChanged
      ? ((
          await tx.contractStatusHistory.findFirst({
            where: { contractId: input.contractId },
            orderBy: { contractStatusHistoryId: 'desc' },
            select: { contractStatusHistoryId: true },
          })
        )?.contractStatusHistoryId ?? null)
      : null;
    const store = await tx.store.findUnique({
      where: { storeId: input.storeId },
      select: { name: true },
    });
    return {
      ...input,
      kind: 'INVITE',
      code,
      token: link.token,
      invitationId: invitation.invitationId,
      unlockAttemptId: unlock.invitationCodeAttemptId,
      affiliation: null,
      historyId,
      expired: previous.map((p) => p.invitationId),
      storeName: store?.name ?? '',
      now,
    };
  }

  /**
   * 소속 추가 확인 요청(WHALEERP-130, 2026-10-26 재영). 계정은 있고 이 점포 레코드에 아직 잇지 않은 번호다 — 소속 추가 확인 ·
   * 복귀 확인 초대 한 줄(30일)을 만들고 직원을 초대 발송으로 둔다. 코드 · 링크 토큰은 없다 — 요청은 후보 계정(candidate_account_id,
   * 저장 · 재발송의 판별이 남긴다)에 걸려 직원이 로그인하면 앱이 찾는다. 후보 계정은 그대로 둔다. 알림톡 · 메일은 커밋 뒤
   * dispatch 가 보낸다.
   */
  private async prepareAffiliation(
    tx: Prisma.TransactionClient,
    input: DeliveryInput,
    now: Date,
    expiresAt: Date,
    previous: { invitationId: number }[],
    contract: {
      employmentType: EmploymentType | null;
      jobTitle: string | null;
    },
  ): Promise<PendingInvite> {
    const { staffMemberId } = input.before;
    const invitation = await tx.invitation.create({
      data: {
        staffMemberId,
        invitationType:
          input.draftAction === 'RETURN_CONFIRM'
            ? 'RETURN_CONFIRM'
            : 'AFFILIATION_CONFIRM',
        channel: 'ALIMTALK',
        sentAt: now,
        expiresAt,
        status: 'SENT',
      },
      select: { invitationId: true },
    });
    const staff = await tx.staffMember.update({
      where: { staffMemberId },
      data: { joinStatus: 'INVITED' },
      select: {
        employmentType: true,
        jobTitle: true,
        candidateAccountId: true,
      },
    });
    // 알리는 고용 형태는 이 계약의 것 — 직원 레코드는 계약이 시작할 때 옮긴다(applyStartedTerms, WHALEERP-156)
    const { employmentType } = pendingTermsOf(staff, contract);
    const account =
      staff.candidateAccountId === null
        ? null
        : await tx.account.findUnique({
            where: { accountId: staff.candidateAccountId },
            select: { email: true },
          });
    const historyId = input.statusChanged
      ? ((
          await tx.contractStatusHistory.findFirst({
            where: { contractId: input.contractId },
            orderBy: { contractStatusHistoryId: 'desc' },
            select: { contractStatusHistoryId: true },
          })
        )?.contractStatusHistoryId ?? null)
      : null;
    const store = await tx.store.findUnique({
      where: { storeId: input.storeId },
      select: { name: true, bpCode: { select: { tradeName: true } } },
    });
    return {
      ...input,
      kind: 'AFFILIATION',
      code: null,
      token: null,
      invitationId: invitation.invitationId,
      unlockAttemptId: null,
      affiliation: {
        bpName: store?.bpCode.tradeName ?? '',
        // 알림톡 · 메일 변수는 빈 문자열이어도 렌더된다
        employmentType: employmentTypeLabel(employmentType) ?? '',
        email: account?.email ?? null,
      },
      historyId,
      expired: previous.map((p) => p.invitationId),
      storeName: store?.name ?? '',
      now,
    };
  }

  /**
   * 근로계약서 발송 직원 알림(PUSH_CONTRACT_SENT, #259) — 가입한 직원이 앱으로 받을 때. 저장 · 재발송 · 수정 요청 계약 고침이
   * 모두 이 길로 와 보낼 때마다 하나다. 받을 계정이 없거나(데이터 손상 — error) 탈퇴했으면(warn) 만들지 않고 남긴다(NTF-25).
   * 템플릿 문제로 만들지 못해도 저장은 그대로다(noticeStaff).
   */
  private async noticeSent(
    tx: Prisma.TransactionClient,
    input: DeliveryInput,
    deadline: Date,
  ): Promise<void> {
    const staff = await tx.staffMember.findUnique({
      where: { staffMemberId: input.before.staffMemberId },
      select: { accountId: true, account: { select: { status: true } } },
    });
    // 가입한 직원인데 계정이 없으면 데이터가 깨진 것이라 error(가입이 계정 연결 · 가입 완료를 한 번에 쓴다), 탈퇴는 있을 수
    // 있는 일이라 warn — 둘 다 알림 없이 기한만 새로 잡는다
    if (!staff?.accountId) {
      this.logger.error(
        `contract notice SKIPPED contract=${input.contractId}: no account on a joined staff member`,
      );
      return;
    }
    if (staff.account?.status === 'WITHDRAWN') {
      this.logger.warn(
        `contract notice SKIPPED contract=${input.contractId}: withdrawn account`,
      );
      return;
    }
    const store = await tx.store.findUnique({
      where: { storeId: input.storeId },
      select: { name: true },
    });
    // 날인 기한은 한국 날짜로 — 템플릿 예시 「10월 30일」
    const day = new Date(deadline.getTime() + 9 * 60 * 60 * 1000);
    await noticeStaff(tx, this.logger, {
      templateCode: 'PUSH_CONTRACT_SENT',
      accountId: staff.accountId,
      relatedType: 'CONTRACT',
      relatedId: input.contractId,
      variables: {
        근무지: store?.name ?? '',
        날인기한: `${day.getUTCMonth() + 1}월 ${day.getUTCDate()}일`,
      },
    });
  }

  /**
   * 커밋 뒤 가입 초대 알림톡을 보낸다(없으면 아무것도 하지 않는다). 실패하면 502 — 본문에 계약 ID 와 되돌린 뒤의 상태를
   * 싣는다(저장은 이미 끝나 화면이 그 계약으로 가야 한다).
   * 보내기 직전에 이 초대가 아직 「보냄」인지 다시 본다 — 커밋과 발송 사이에 발송 대기 종료(WHALEERP-327) · 다른 재발송이
   * 초대를 무효로 했으면 쓸 수 없는 코드 · 링크라 보내지 않고 false 를 돌려준다(그 요청이 상태를 정했다 — 재발송은 409 로 알린다).
   * 건너뛸 때도 나가지 않은 내 초대 · 잠금 해제 행은 undo 로 지운다 — 남겨 두면 뒤이은 다른 요청의 되돌리기가 「앞 초대」로
   * 되살려, 한 번도 나가지 않은 코드가 살아 있는 초대가 된다(api #144 ip-code-review). 읽은 뒤 보내기 전의 짧은 틈은 남는다.
   * 그사이 직원이 답했으면(수락 · 거절 — 소속 추가 확인 요청은 커밋 직후 직원 앱 목록에 보여 알림톡 전에 답할 수 있다) 처리가
   * 끝난 것이라 보내지 않고 'ANSWERED' 다. 발송이 실패한 뒤 되돌리다 답한 것을 알아도 같다 — 답한 요청 · 그 계약은 건드리지
   * 않는다. 계약은 그 답으로 서명 대기 · 거부가 됐으니 호출부는 미리 계산한 상태가 아니라 지금 값을 다시 읽어 답한다.
   * 보냈거나 보낼 것이 없으면 true.
   */
  async dispatch(
    pending: PendingInvite | null,
    sentBy: number,
  ): Promise<DispatchResult> {
    if (!pending) return true;
    const { contractId } = pending;
    const mine = await this.prisma.invitation.findUnique({
      where: { invitationId: pending.invitationId },
      select: { status: true },
    });
    if (answered(mine?.status)) {
      this.logger.warn(
        `알림톡을 보내지 않음: 계약 ${contractId} 의 초대에 직원이 이미 답했다`,
      );
      return 'ANSWERED';
    }
    if (mine?.status !== 'SENT') {
      this.logger.warn(
        `${pending.kind === 'INVITE' ? '가입 초대' : '소속 추가 확인 요청'} 알림톡을 보내지 않음: 계약 ${contractId} 의 초대를 그사이 다른 요청이 무효로 했다`,
      );
      await this.undo(pending).catch((u: unknown) =>
        this.logger.error(
          `보내지 않은 초대 정리 실패 contract=${contractId}`,
          u instanceof Error ? u.stack : String(u),
        ),
      );
      return false;
    }
    const what =
      pending.kind === 'INVITE' ? '가입 초대' : '소속 추가 확인 요청';
    try {
      if (pending.kind === 'INVITE')
        await this.alimtalk.send({
          templateCode: INVITATION_TEMPLATE,
          to: pending.phone,
          variables: {
            근무지: pending.storeName,
            초대코드: pending.code as string,
            링크: inviteLinkOf(this.appUrl as string, pending.token as string),
          },
          // 코드 · 링크 모두 가입 열쇠라 발송 이력에서 가린다
          maskedVariables: ['초대코드', '링크'],
          related: { type: 'contract', id: contractId },
          sentBy,
        });
      else
        await this.alimtalk.send({
          templateCode: AFFILIATION_TEMPLATE,
          to: pending.phone,
          variables: this.affiliationVariables(pending),
          related: { type: 'contract', id: contractId },
          sentBy,
        });
    } catch (e) {
      if (notSent(e)) {
        if (!(e instanceof BizppurioError))
          this.logger.error(
            `알림톡을 보내기 전에 실패 contract=${contractId}`,
            e instanceof Error ? e.stack : String(e),
          );
        // 되돌리기가 실패하면 DB 는 「보낸 상태」라 접수 여부 모름과 같게 답한다(화면이 상세를 다시 읽게)
        const undone = await this.undo(pending).catch((u: unknown) => {
          this.logger.error(
            `발송 실패 뒤 되돌리기 실패 contract=${contractId}`,
            u instanceof Error ? u.stack : String(u),
          );
          return null;
        });
        if (undone === 'ANSWERED') return undone;
        const status = undone;
        if (status === null)
          throw new BadGatewayException({
            statusCode: HttpStatus.BAD_GATEWAY,
            error: 'Bad Gateway',
            code: 'SEND_UNCONFIRMED',
            retryable: false,
            contractId,
            message: `${what} 알림톡을 보내지 못했는데 되돌리지 못했습니다. 상세를 다시 열어 상태를 확인한 뒤 재발송해 주세요`,
          });
        throw new BadGatewayException({
          statusCode: HttpStatus.BAD_GATEWAY,
          error: 'Bad Gateway',
          code: 'SEND_FAILED',
          retryable: true,
          contractId,
          status,
          message: `${
            e instanceof BizppurioError && e.code !== undefined
              ? `${what} 알림톡을 보내지 못했습니다(비즈뿌리오 ${e.code}). 번호를 확인하고`
              : `${what} 알림톡을 보내지 못했습니다. 잠시 뒤`
          } 다시 보내 주세요${status === 'DRAFT' && pending.before.status !== 'DRAFT' ? ' — 근로계약서는 임시저장으로 두었습니다' : ''}`,
        });
      }
      this.logger.error(
        `알림톡 접수 여부를 알 수 없음 contract=${contractId}`,
        e instanceof Error ? e.stack : String(e),
      );
      throw new BadGatewayException({
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'Bad Gateway',
        code: 'SEND_UNCONFIRMED',
        retryable: false,
        contractId,
        message: `${what} 알림톡이 접수됐는지 알 수 없습니다. 직원에게 받았는지 확인한 뒤 다시 보내 주세요 — 다시 보내면 두 번 갈 수 있습니다`,
      });
    }

    // 소속 추가 확인 요청은 계정의 이메일로도 알린다 — 알림톡과 따로라 실패해도 저장 · 응답은 그대로다(로그만)
    if (pending.kind === 'AFFILIATION') await this.mailAffiliation(pending);
    return true;
  }

  /** 소속 추가 확인 요청 알림톡 · 메일 변수 — 링크는 직원 앱 요청 화면(로그인하면 그 계정의 요청을 찾는다) */
  private affiliationVariables(p: PendingInvite): Record<string, string> {
    return {
      사업자: p.affiliation?.bpName ?? '',
      근무지: p.storeName,
      고용형태: p.affiliation?.employmentType ?? '',
      링크: affiliationLinkOf(this.appUrl as string),
    };
  }

  private async mailAffiliation(p: PendingInvite): Promise<void> {
    const email = p.affiliation?.email;
    if (!this.mail || !email) {
      this.logger.warn(
        `affiliation request mail SKIPPED contract=${p.contractId}: ${!this.mail ? 'no MAIL_*' : 'no email'}`,
      );
      return;
    }
    await this.mail
      .send({
        templateCode: AFFILIATION_MAIL_TEMPLATE,
        to: email,
        variables: this.affiliationVariables(p),
      })
      // 메시지는 남기지 않는다 — SMTP 오류에는 받는 주소가 섞인다(근로계약 알림 메일과 같다)
      .catch((e: unknown) =>
        this.logger.error(
          `affiliation request mail FAILED contract=${p.contractId} ${errorKind(e)}`,
        ),
      );
  }

  /**
   * 나가지 않은 가입 초대를 되돌리고 되돌린 뒤의 상태를 돌려준다. 새 초대와 이 저장의 상태 이력을 지우고, 번호가 그대로면
   * 무효로 했던 앞 초대를 되살리고, 계약 · 직원을 보내기 직전으로 돌린다. 고친 내용(이름 · 번호 · 계약 칸)은 그대로다.
   * - 돌아갈 상태에 살아 있는 받을 길이 없으면(새 계약 · 임시저장에서 넘김 · 번호를 바꿈 · 앞 초대가 없음) 임시저장으로 둔다
   *   — 발송 대기 · 서명 대기는 「초대가 나갔다」는 뜻이라, 나간 것이 없으면 남기지 않는다(api #59 재리뷰 A).
   * - 그사이 다른 요청이 다시 보냈거나 계약을 바꿨으면(내 초대가 이미 「보냄」이 아니거나 발송 일시가 이 요청의 것이
   *   아님) 나가지 않은 내 초대만 지우고 나머지는 그 요청에 맡긴다.
   */
  private async undo(
    p: PendingInvite,
  ): Promise<ContractStatus | 'ANSWERED' | null> {
    return this.prisma.$transaction(async (tx) => {
      const { contractId, before } = p;
      // 직원 행 → 계약 행 — 되돌리기가 직원 행(가입 상태)을 쓴다. 계약 행부터 잡으면 이어 쓰기와 고리가 생긴다(api #104)
      await lockStaffMember(tx, before.staffMemberId, 'write');
      await lockContract(tx, contractId);
      const mine = await tx.invitation.findUnique({
        where: { invitationId: p.invitationId },
        select: { status: true },
      });
      const c = await tx.contract.findUnique({
        where: { contractId },
        select: { status: true, sentAt: true },
      });
      // 직원이 이미 답한 요청은 지우지도 되돌리지도 않는다 — 수락으로 이어진 레코드 · 서명 대기 계약, 거절로 닫힌 계약이 그 답의 것이다
      if (answered(mine?.status)) return 'ANSWERED';
      if (mine)
        await tx.invitation.delete({ where: { invitationId: p.invitationId } });
      // 초대가 나가지 않았으니 이 발송이 푼 잠금도 되돌린다 — 입력 쪽과 같은 번호 키로 줄을 서서, 해제 행과 그 뒤에 쌓인
      // 시도를 함께 지워 앞 상태(잠금 포함)를 다시 판정 기준으로 둔다. 해제 행만 지우면 그사이 실패가 0 에서 센 행이
      // 기준이 돼 잠금이 풀린 채 남는다(api #81 재리뷰). 그 뒤 첫 해제 · 성공 행(isSucceeded — 다른 재발송의 해제나 맞는
      // 코드) 앞에서 멈춘다 — 그 행부터는 그 요청이 푼 잠금이라, 지우면 그 요청으로 받은 코드가 막힌다(api #81 3차 리뷰).
      // 「실패 0 · 잠금 없음」으로 가리면 끝난 초대가 맞아 옮겨 적은 행에서도 멈춰 잠금이 풀린 채 남았다(api #81 4차 리뷰)
      // 소속 추가 확인 요청은 코드가 없어 푼 잠금도 없다
      if (p.unlockAttemptId !== null) {
        const phoneKey = invitationCodePhoneKeyOf(this.codeSecret, p.phone);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phoneKey}))`;
        const nextReset = await tx.invitationCodeAttempt.findFirst({
          where: {
            phoneKey,
            invitationCodeAttemptId: { gt: p.unlockAttemptId },
            isSucceeded: true,
          },
          orderBy: { invitationCodeAttemptId: 'asc' },
          select: { invitationCodeAttemptId: true },
        });
        await tx.invitationCodeAttempt.deleteMany({
          where: {
            phoneKey,
            invitationCodeAttemptId: {
              gte: p.unlockAttemptId,
              ...(nextReset && { lt: nextReset.invitationCodeAttemptId }),
            },
          },
        });
      }
      if (mine?.status !== 'SENT' || c?.sentAt?.getTime() !== p.now.getTime()) {
        this.logger.warn(
          `발송 되돌리기: 계약 ${contractId} 를 그사이 다른 요청이 바꿔 초대만 지웠다`,
        );
        return c?.status ?? null;
      }
      // 번호를 바꿨거나 다시 판별해 받을 길이 바뀌었거나 다른 계약을 대체한 저장이면 앞 초대를 되살리지 않는다 — 옛 번호 ·
      // 옛 판별(예: 그사이 계정이 생긴 번호의 가입 초대) · 종료된 계약 때 나간 링크다(api #65 리뷰 · #164 리뷰)
      const rejudged = rejudgedOf(p);
      if (!rejudged && !p.replacedContracts && p.expired.length)
        await tx.invitation.updateMany({
          where: { invitationId: { in: p.expired }, status: 'EXPIRED' },
          data: { status: 'SENT' },
        });
      const live = await this.hasLiveInvitation(tx, before.staffMemberId);
      const restored = restoredStatusOf(p, live);
      await tx.contract.update({
        where: { contractId },
        data: {
          status: restored,
          sentAt: restored === 'DRAFT' ? null : before.sentAt,
          signDeadlineAt: restored === 'DRAFT' ? null : before.signDeadlineAt,
          // 번호를 바꿨거나 다시 판별해 바뀐 저장은 새로 판별한 값을 남긴다 — 옛 초대 유형이 남으면 다음 저장이 판별을 건너뛰어
          // 알림 없이 서명 대기가 되거나(api #65 리뷰), 후보 계정 · 되살린 초대와 어긋난다(api #164 리뷰)
          draftAction: rejudged ? p.draftAction : before.draftAction,
          // 이 발송이 센 재발송을 뺀다(prepare 와 같은 조건)
          ...(before.sentAt !== null && { resendCount: { decrement: 1 } }),
        },
      });
      if (p.historyId !== null) {
        // 새 계약은 처음 이력 한 줄(→ 발송 대기)이 이 저장의 것이라 임시저장으로 고쳐 둔다. 나머지는 지운다.
        if (before.status === null)
          await tx.contractStatusHistory.update({
            where: { contractStatusHistoryId: p.historyId },
            data: { toStatus: 'DRAFT' },
          });
        else
          await tx.contractStatusHistory.delete({
            where: { contractStatusHistoryId: p.historyId },
          });
      }
      // 보내기 전과 다른 상태로 돌아갔다(보낸 상태였는데 받을 길이 없어 임시저장) — 그 일을 이력에 남긴다
      if (before.status !== null && restored !== before.status)
        await tx.contractStatusHistory.create({
          data: {
            contractId,
            fromStatus: before.status,
            toStatus: restored,
            actor: 'SYSTEM',
          },
        });
      if (before.staffMember.joinStatus === 'DRAFT' || !live)
        await tx.staffMember.updateMany({
          where: { staffMemberId: before.staffMemberId, joinStatus: 'INVITED' },
          data: {
            joinStatus: 'DRAFT',
            // 가입 초대(계정 없는 번호)는 보낼 때 후보 계정을 비웠으니 되살린다 — 다시 판별해 바뀌었으면(번호 변경 포함) 새 판별대로
            // 후보 계정이 없다. 소속 추가 확인 요청은 후보 계정을 건드리지 않았다(저장의 판별이 쓴 값을 둔다) — 셋(초대 유형 ·
            // 후보 계정 · 되살린 초대)이 늘 같은 판별을 가리킨다
            ...(p.kind === 'INVITE' && {
              candidateAccountId: rejudged
                ? null
                : before.staffMember.candidateAccountId,
            }),
          },
        });
      return restored;
    });
  }

  private async hasLiveInvitation(
    tx: Prisma.TransactionClient,
    staffMemberId: number,
  ): Promise<boolean> {
    return (
      (await tx.invitation.count({
        where: { staffMemberId, status: 'SENT' },
      })) > 0
    );
  }
}

/** 직원이 답한 초대(수락 · 거절) — 보내기 · 되돌리기가 손대지 않는다 */
const answered = (status: string | undefined) =>
  status === 'ACCEPTED' || status === 'REJECTED';

/**
 * 되돌릴 때 앞 판별을 버리는가 — 번호를 바꿨거나, 보낸 적 있는 계약을 다시 판별해 초대 유형이 바뀌었다(근로자 정보 수정 ·
 * 재발송은 번호가 같아도 다시 판별한다, api #164 리뷰). 임시저장 · 새 계약은 돌아갈 판별이 없어 번호만 본다.
 */
const rejudgedOf = (
  p: Pick<PendingInvite, 'before' | 'phoneChanged' | 'draftAction'>,
) =>
  p.phoneChanged ||
  (p.before.status !== null &&
    p.before.status !== 'DRAFT' &&
    p.draftAction !== p.before.draftAction);

/**
 * 되돌린 뒤의 상태. 임시저장 · 새 계약이면 임시저장, 수정 요청이면 수정 요청(받을 길이 없어도 되는 상태)이다. 발송 대기 ·
 * 서명 대기였으면 판별이 그대로(번호 · 초대 유형)이고 받을 길(살아 있는 초대, 또는 가입 초대가 아닌 서명 대기 — 앱으로 받는
 * 직원, 이 변경 전 요청 없이 서명 대기가 된 소속 확인 계약)이 남아 있을 때만 그 상태로 돌아가고, 아니면 임시저장이다. 옛 소속
 * 확인 계약은 서명 대기 · 기한 그대로 돌아가야 한다 — 임시저장이면 발송 일시 · 기한이 지워진다(api #164 리뷰).
 */
export function restoredStatusOf(
  p: Pick<PendingInvite, 'before' | 'phoneChanged' | 'joined' | 'draftAction'>,
  liveInvitation: boolean,
): ContractStatus {
  const { status, draftAction } = p.before;
  if (status === null || status === 'DRAFT') return 'DRAFT';
  if (status === 'CORRECTION_REQUESTED') return status;
  const reachable =
    liveInvitation ||
    (status === 'PENDING_SIGNATURE' &&
      channelOf(p.joined, draftAction) !== 'INVITE');
  return !rejudgedOf(p) && reachable ? status : 'DRAFT';
}
