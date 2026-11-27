import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { verifyPassword } from '../auth/password';
import { dateOnly } from '../common/date-only';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import type { OptionalMailService } from '../mail/mail.module';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import {
  endPendingContracts,
  PENDING_CONTRACT_STATUSES,
} from '../staff-members/retirement.service';
import { CURRENT_PASSWORD_MISMATCH_MESSAGE } from './my-password.service';
import type {
  EmployedStoreDto,
  MyWithdrawalEligibilityResponseDto,
} from './dto/my-withdrawal.response.dto';

export const EMPLOYED_CONFLICT_MESSAGE =
  '근무지 관리자에게 퇴직 처리를 요청해 주세요.';
const BUSY =
  '다른 처리와 겹쳐 탈퇴하지 못했습니다. 바뀐 것은 없으니 잠시 뒤 다시 시도해 주세요.';
const NOTICE_TEMPLATE = 'NTF_STAFF_WITHDRAWN';
const MAIL_TEMPLATE = 'EMAIL_STAFF_WITHDRAW_DONE';
const TRANSACTION_TIMEOUT_MS = 15_000;

type Tx = Prisma.TransactionClient;

/** 커밋 뒤 근무지 관리자에게 알릴 직원 레코드 하나 — 받는 사람은 동의를 지우기 전에(커밋 전) 정해 둔다 */
type Notice = {
  staffMemberId: number;
  staffName: string;
  storeName: string;
  recipients: number[];
};

/**
 * 직원 앱 회원 탈퇴 (WHALEERP-770, 2026-11-24 노영주 확정). 계정 행은 지우지 않는다 — 직원 레코드 · 계약 · 출퇴근이 account_id 로
 * 이어져 있어 근무지 데이터로 남는다. 개인정보 칸을 비우고 상태를 WITHDRAWN 으로 바꾼다. 유예기간은 없고 즉시 처리한다.
 *
 * 막는 것은 하나 — 이 계정에 이어진 직원 레코드 가운데 가입 완료(JOINED) · 재직(EMPLOYED)이 하나라도 있으면 409(퇴직 예정, 즉
 * 퇴직일이 있어도 재직이라 막는다). 근무지 관리자가 퇴직 처리한 뒤에 탈퇴할 수 있다. 막지 않는 것: 대기 계약 · 안 본 급여명세서.
 *
 * 한 트랜잭션에서 하는 일(허용일 때)
 * 1. 잠금 — 직원 레코드(`account_id` 또는 `candidate_account_id` 가 이 계정) id 순 `FOR NO KEY UPDATE` → 계정 행 `FOR UPDATE`
 *    → 다시 판정. 점포 → 직원 → 계정인 퇴직 · 폐점의 잠금 순서(`RetirementService.lockStaff` · `retireStores`)와 같아 관리자의
 *    퇴직 처리 · 점포 폐점과 교착하지 않는다. 계정부터 잡는 직원 앱 경로(소속 추가 수락 · 근무지 더하기)와 같은 계정이 동시에 부딪치면
 *    엇갈릴 수 있어, 교착이면 처음부터 한 번 다시 하고 또 교착이면 409 로 「바뀐 것 없음 · 다시 시도」를 알린다.
 * 2. 대기 계약 4종(임시저장 · 발송 대기 · 서명 대기 · 수정 요청)을 종료로 닫고 상태 이력을 남긴다(actor STAFF) —
 *    `endPendingContracts`, 퇴직 · 폐점과 같은 함수.
 * 3. 발송(SENT) 초대는 만료로 바꾸고, 후보 계정(`candidate_account_id`)을 비우고, 열린 연결 보류(link_holds, 처리 결과 없음)는
 *    지운다(처리 결과가 승인 · 재초대 둘뿐이라 「닫음」 값이 없다).
 * 4. 위치정보 파기(위치정보법 제24조 제4항) — 확인자료(location_access_logs), 동의 이력, 동의.
 * 5. 계정에 달린 개인정보 — 로그인 · 변경 이력, 약관 동의 이력(접속 IP), 본인인증 이력, 알림 수신 설정, 이메일 변경 핀, 비밀번호 재설정 핀 · 링크.
 *    알림함(notification_recipients · deliveries)은 지우지 않는다(근무지가 보낸 알림 이력).
 * 6. 접속 전부 종료(revokeAll)하고 기기 식별 정보를 비운다.
 * 7. accounts 행 — 개인정보 칸을 NULL, 본사 제공 동의는 「동의한 적 없음」으로, 약관 동의 일시도 비운다.
 *
 * 커밋 뒤: 근무지 관리자 운영 알림(NTF_STAFF_WITHDRAWN, 이 계정에 이어진(`account_id`) 모든 직원 레코드와, 계약을 닫거나 초대를 만료시킨 후보 레코드(같은 근무지는 한 번)의 근무지 — 받는 사람은 동의를
 * 지우기 전에 정한다), 직원 완료 메일(지우기 전에 읽어 둔 이메일로). 알림 · 메일 실패는 탈퇴를 되돌리지 않는다.
 *
 * 지금 비밀번호 재확인은 내 정보 비밀번호 변경과 같다 — 틀리면 400, 로그인 실패 횟수는 세지 않고 요청 한도(계정마다 10분에 10번)만 건다.
 */
@Injectable()
export class MyWithdrawalService {
  private readonly logger = new Logger(MyWithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionService,
    private readonly ops: OpsNotificationService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
  ) {}

  /** 탈퇴 전 조건 — 재직 중인 근무지와 함께 종료될 대기 계약 수. 아무것도 쓰지 않는다 */
  async getEligibility(
    accountId: number,
  ): Promise<MyWithdrawalEligibilityResponseDto> {
    await this.liveAccount(this.prisma, accountId);
    const employedStores = await employedStoresOf(this.prisma, accountId);
    const pendingContractCount = await this.prisma.contract.count({
      where: {
        status: { in: PENDING_CONTRACT_STATUSES },
        staffMember: { OR: mineWhere(accountId) },
      },
    });
    return {
      canWithdraw: employedStores.length === 0,
      employedStores,
      pendingContractCount,
    };
  }

  async withdraw(accountId: number, currentPassword: string): Promise<void> {
    const account = await this.liveAccount(this.prisma, accountId);
    if (!(await verifyPassword(currentPassword, account.passwordHash)))
      throw new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE);

    const now = new Date();
    const done = await this.inTransaction(accountId, (tx) =>
      this.erase(tx, accountId, account.passwordHash, now),
    );

    for (const notice of done.notices)
      await this.ops.notify({
        templateCode: NOTICE_TEMPLATE,
        variables: { 직원이름: notice.staffName, 근무지: notice.storeName },
        related: { type: 'STAFF_MEMBER', id: notice.staffMemberId },
        link: `/staff-members/${notice.staffMemberId}`,
        eventKey: `${accountId}:${notice.staffMemberId}`,
        recipients: notice.recipients,
      });
    await this.sendDoneMail(accountId, done.email, done.realName);
  }

  /** 교착이면 처음부터 한 번 다시 한다. 또 교착이면 아무것도 바뀌지 않았다고 알린다(다른 오류는 그대로). */
  private async inTransaction<T>(
    accountId: number,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const run = () =>
      this.prisma.$transaction(work, { timeout: TRANSACTION_TIMEOUT_MS });
    try {
      return await run();
    } catch (error) {
      if (!isDeadlock(error)) throw error;
      this.logger.warn(
        `회원 탈퇴 교착 — 한 번 다시 한다 (accountId=${accountId}): ${error.message}`,
      );
    }
    try {
      return await run();
    } catch (error) {
      if (!isDeadlock(error)) throw error;
      this.logger.warn(
        `회원 탈퇴 교착 — 다시 해도 겹쳐 409 (accountId=${accountId}): ${error.message}`,
      );
      throw new ConflictException(BUSY);
    }
  }

  private async erase(
    tx: Tx,
    accountId: number,
    verifiedHash: string | null,
    now: Date,
  ): Promise<{
    email: string | null;
    realName: string | null;
    notices: Notice[];
  }> {
    // 직원 → 계정 순으로 잠근다(위 클래스 주석 1).
    await tx.$queryRaw`SELECT staff_member_id FROM staff_members WHERE account_id = ${accountId} OR candidate_account_id = ${accountId} ORDER BY staff_member_id FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
    const account = await this.liveAccount(tx, accountId);
    // 확인하는 사이 비밀번호가 바뀌었으면 확인한 값은 지금 비밀번호가 아니다(내 정보 비밀번호 변경과 같다)
    if (account.passwordHash !== verifiedHash)
      throw new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE);

    // 잠근 뒤에 다시 판정한다 — 그 사이 가입이 이어졌거나 퇴직이 취소됐을 수 있다.
    const employedStores = await employedStoresOf(tx, accountId);
    if (employedStores.length > 0)
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'EMPLOYED_AFFILIATION',
        message: EMPLOYED_CONFLICT_MESSAGE,
        employedStores,
      });

    const members = await tx.staffMember.findMany({
      where: { OR: mineWhere(accountId) },
      select: {
        staffMemberId: true,
        storeId: true,
        name: true,
        accountId: true,
      },
      orderBy: { staffMemberId: 'asc' },
    });
    const staffMemberIds = members.map((m) => m.staffMemberId);

    // 알릴 받는 사람은 본사 제공 동의를 지우기 전에 정한다 — 지운 뒤에는 가맹 점포를 보는 본사 역할 관리자(hidesPersonalData, HQ_ROLES)가 가림 기준에 걸려 받지 못한다.
    // 대상: 이어진 레코드(근무지마다 하나) + 후보 레코드 중 이번에 계약을 닫거나 초대를 만료시키는 레코드(정책 2 — 대기 계약 종료를 근무지에 알린다).
    // 같은 근무지는 한 번만 알린다.
    const candidates = members.filter((m) => m.accountId !== accountId);
    const affected = new Set(
      candidates.length === 0
        ? []
        : [
            ...(
              await tx.contract.findMany({
                where: {
                  staffMemberId: { in: candidates.map((m) => m.staffMemberId) },
                  status: { in: PENDING_CONTRACT_STATUSES },
                },
                select: { staffMemberId: true },
              })
            ).map((c) => c.staffMemberId),
            ...(
              await tx.invitation.findMany({
                where: {
                  staffMemberId: { in: candidates.map((m) => m.staffMemberId) },
                  status: 'SENT',
                },
                select: { staffMemberId: true },
              })
            ).map((i) => i.staffMemberId),
          ],
    );
    // 근무지마다 한 번 — 이어진 레코드(재입사 등으로 한 근무지에 둘 이상일 수 있다)가 먼저, 후보 레코드는 그다음이다.
    const seenStores = new Set<number>();
    const targets = [
      ...members.filter((m) => m.accountId === accountId),
      ...candidates.filter((m) => affected.has(m.staffMemberId)),
    ].filter((m) => {
      if (seenStores.has(m.storeId)) return false;
      seenStores.add(m.storeId);
      return true;
    });
    const notices = await this.noticesOf(tx, targets);

    await endPendingContracts(
      tx,
      { staffMemberId: { in: staffMemberIds } },
      'STAFF',
    );
    await tx.invitation.updateMany({
      where: { staffMemberId: { in: staffMemberIds }, status: 'SENT' },
      data: { status: 'EXPIRED' },
    });
    await tx.staffMember.updateMany({
      where: { candidateAccountId: accountId },
      data: { candidateAccountId: null },
    });
    await tx.linkHold.deleteMany({ where: { accountId, resolution: null } });

    // 위치정보 파기 — 동의 이력이 동의를 가리키므로 이력 → 동의 순이다.
    await tx.locationAccessLog.deleteMany({ where: { accountId } });
    await tx.locationConsentHistory.deleteMany({
      where: { locationConsent: { accountId } },
    });
    await tx.locationConsent.deleteMany({ where: { accountId } });

    // 이력에는 계정이 지워지기 전 이메일이 남아 있다 — 계정을 가리키지 못한 로그인 시도(없는 계정으로 남긴 이력)도 같은 이메일이면
    // 함께 지운다. 본인인증은 이 계정에 귀속된 것만 지운다 — 계정 없이 남은 기록은 같은 번호로 가입하려는 다른 사람의 것일 수 있다.
    const { email } = account;
    await tx.loginHistory.deleteMany({
      where: { OR: [{ accountId }, { accountId: null, email }] },
    });
    await tx.accountChangeHistory.deleteMany({ where: { accountId } });
    await tx.accountTermsAgreementLog.deleteMany({ where: { accountId } });
    await tx.identityVerification.deleteMany({
      where: { accountId },
    });
    await tx.notificationPreference.deleteMany({ where: { accountId } });
    await tx.emailChangePin.deleteMany({ where: { accountId } });
    await tx.passwordResetPin.deleteMany({ where: { accountId } });
    await tx.passwordResetLink.deleteMany({ where: { accountId } });

    await this.sessions.revokeAll(accountId, tx);
    await tx.authSession.updateMany({
      where: { accountId },
      data: { deviceIdentifier: null },
    });

    await tx.account.update({
      where: { accountId },
      data: {
        status: 'WITHDRAWN',
        email: null,
        passwordHash: null,
        realName: null,
        birthDate: null,
        phone: null,
        gender: null,
        isForeigner: false,
        connectingInformation: null,
        zipCode: null,
        address: null,
        addressDetail: null,
        // 본사 제공 동의 — 「동의한 적 없음」(CHECK accounts_hq_sharing_*): 동의 안 함 + 버전 · 일시 모두 비움
        isHqSharingConsented: false,
        hqSharingConsentVersion: null,
        hqSharingAgreedAt: null,
        hqSharingWithdrawnAt: null,
        termsAgreedAt: null,
        failedLoginCount: 0,
        lockExpiresAt: null,
      },
    });
    this.logger.log(
      `직원 앱 회원 탈퇴 accountId=${accountId} staffMembers=${staffMemberIds.length} at=${now.toISOString()}`,
    );
    return { email, realName: account.realName, notices };
  }

  /** 알릴 직원 레코드마다 — 근무지 이름과 알릴 관리자(동의를 지우기 전 기준) */
  private async noticesOf(
    tx: Tx,
    linked: { staffMemberId: number; storeId: number; name: string }[],
  ): Promise<Notice[]> {
    if (linked.length === 0) return [];
    const stores = await tx.store.findMany({
      where: { storeId: { in: [...new Set(linked.map((m) => m.storeId))] } },
      select: { storeId: true, name: true },
    });
    const nameOf = new Map(stores.map((s) => [s.storeId, s.name]));
    const notices: Notice[] = [];
    for (const m of linked)
      notices.push({
        staffMemberId: m.staffMemberId,
        staffName: m.name,
        storeName: nameOf.get(m.storeId) ?? '',
        recipients: await storeManagers(tx, m.staffMemberId),
      });
    return notices;
  }

  /** 탈퇴 완료 메일. 메일 설정이 없으면 보내지 않고, 실패는 기록만 한다 — 탈퇴는 이미 끝났다. */
  private async sendDoneMail(
    accountId: number,
    email: string | null,
    realName: string | null,
  ): Promise<void> {
    if (!this.mail || !email || !realName) return;
    try {
      await this.mail.send({
        templateCode: MAIL_TEMPLATE,
        to: email,
        variables: { 직원이름: realName },
        accountId,
      });
    } catch (error) {
      this.logger.error(
        `탈퇴 완료 메일 발송 실패(accountId=${accountId})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** 탈퇴하지 않은 계정만. 없거나 이미 탈퇴했으면 401(접속이 끝난 것과 같다) */
  private async liveAccount(db: Pick<Tx, 'account'>, accountId: number) {
    const account = await db.account.findUnique({
      where: { accountId },
      select: {
        email: true,
        passwordHash: true,
        realName: true,
        phone: true,
        status: true,
      },
    });
    // 칸이 비어 있는 것도 탈퇴한 계정이다(탈퇴가 아니면 다섯 칸이 있다 — CHECK)
    if (
      !account ||
      account.status === 'WITHDRAWN' ||
      account.email === null ||
      account.passwordHash === null ||
      account.realName === null ||
      account.phone === null
    )
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    return {
      email: account.email,
      passwordHash: account.passwordHash,
      realName: account.realName,
      phone: account.phone,
    };
  }
}

/** 이 계정에 이어진 직원 레코드 — 가입한 것(account_id)과 후보로 걸린 것(candidate_account_id) */
const mineWhere = (accountId: number): Prisma.StaffMemberWhereInput[] => [
  { accountId },
  { candidateAccountId: accountId },
];

/**
 * 탈퇴를 막는 근무지 — 가입 완료 · 재직(퇴직 예정 포함). ACTIVE_STAFF(체결 계약이 있는 재직 직원)가 아니다 — 계약 없이 재직인
 * 레코드도 막는다(2026-11-24 노영주).
 */
async function employedStoresOf(
  db: Pick<Tx, 'staffMember' | 'store'>,
  accountId: number,
): Promise<EmployedStoreDto[]> {
  const rows = await db.staffMember.findMany({
    where: { accountId, joinStatus: 'JOINED', employmentStatus: 'EMPLOYED' },
    select: { storeId: true, retiredDate: true },
    orderBy: { staffMemberId: 'asc' },
  });
  if (rows.length === 0) return [];
  const stores = await db.store.findMany({
    where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
    select: { storeId: true, name: true },
  });
  const nameOf = new Map(stores.map((s) => [s.storeId, s.name]));
  return rows.map((r) => ({
    storeName: nameOf.get(r.storeId) ?? '',
    retiredDate: dateOnly(r.retiredDate),
  }));
}

/**
 * 교착 · 쓰기 충돌인가 — store-closings.service.ts 의 isDeadlock 과 같은 판정이다(그쪽은 폐점 문구에 묶인 파일이라 가져오지 않고
 * 따로 둔다). 일반 쿼리는 P2034, 원시 쿼리(잠금)는 P2010 이고 메시지에 SQLSTATE 40P01 이 실린다.
 */
function isDeadlock(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return (
    error.code === 'P2034' ||
    (error.code === 'P2010' && error.message.includes('Code: `40P01`'))
  );
}
