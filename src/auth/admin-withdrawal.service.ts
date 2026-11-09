import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import type { OptionalMailService } from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import {
  retryOnDeadlock,
  STORE_CLOSING_TRANSACTION_TIMEOUT_MS,
  StoreClosingsService,
} from '../store-closings/store-closings.service';
import { ADMIN_PASSWORD_MESSAGES } from './admin-password-policy';
import type { WithdrawEligibilityResponseDto } from './dto/admin-withdrawal-eligibility.response.dto';
import type { CreateWithdrawalDto } from './dto/admin-withdrawal.dto';
import { verifyPassword } from './password';

const NOT_FOUND = '관리자 계정을 찾을 수 없습니다.';
const NOT_BP_MASTER = 'BP 마스터만 탈퇴할 수 있습니다.';
const PLATFORM_BP = '플랫폼 BP 는 탈퇴할 수 없습니다.';
const REASON_DETAIL_REQUIRED = '탈퇴 사유 상세를 입력해 주세요.';
const BP_MASTER = 'BM';
const WITHDRAWN = 'WITHDRAWN';
const INACTIVE = 'INACTIVE';
const ACTIVE = 'ACTIVE';
const CLOSED = 'CLOSED';
const WITHDRAWN_LABEL = '탈퇴';
const INACTIVE_LABEL = '미사용';
const WITHDRAW_MAIL_TEMPLATE = 'EMAIL_WITHDRAW_DONE';

/** 공통코드 WITHDRAW_REASON. 직접입력(WD_INPUT)만 상세를 받는다. */
export const WITHDRAW_REASON_LABEL: Record<string, string> = {
  WD_CLOSE: '폐업·사업 종료',
  WD_SWITCH: '다른 서비스 이용',
  WD_COST: '비용 부담',
  WD_FEATURE: '기능 부족',
  WD_HARD: '이용이 어려움',
  WD_INPUT: '직접입력',
};
export const WITHDRAW_REASON_CODES = Object.keys(WITHDRAW_REASON_LABEL);
const WD_INPUT = 'WD_INPUT';

/**
 * 탈퇴 직전 관리자 계정 · BP 상태의 한글(공통코드 ACCOUNT_STATUS). 탈퇴한 계정은 앞에서 걸러져 사용 · 미사용만
 * 온다 — platform-admins.service.ts STATUS_LABEL 과 같은 값이다.
 */
const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '사용',
  INACTIVE: '미사용',
};
const accountStatusLabel = (code: string): string =>
  Object.hasOwn(ACCOUNT_STATUS_LABEL, code) ? ACCOUNT_STATUS_LABEL[code] : code;

/** 탈퇴 메일의 탈퇴일 — 한국 날짜 YYYY-MM-DD. */
const kstDateText = (now: Date): string =>
  kstToday(now).toISOString().slice(0, 10);

type Db = PrismaService | Prisma.TransactionClient;

/**
 * 회원 탈퇴(마이페이지 S-JHQQNR). BP 마스터 본인만 받는다 — BP 마스터는 탈퇴, 같은 BP 의 하위 관리자(BP 관리자 ·
 * 가맹마스터 · 가맹관리자)는 「미사용」이 되고 점포는 모두 강제 폐점된다(1팀 규칙, admin_accounts.statusChangedAt
 * 주석 참고). 하위 관리자는 스스로 탈퇴한 것이 아니라 상태는 미사용이지만, 개인정보(이름 · 휴대폰 · 이메일)는 BP 마스터와
 * 같이 지운다 — BP 가 탈퇴하지 않은 하위 관리자의 미사용과는 이 점이 다르다(2026-11-04 사용자 지정, 전엔 하위 관리자도 탈퇴). getEligibility 는 그 전에 보여줄 영향 범위만 세고, execute 가 실제로 탈퇴한다.
 *
 * 점포 폐점은 점포 관리 폐점(PUT /stores/:id)과 같은 StoreClosingsService 로 한다 — 다른 점은 그 BP 의 폐점 안 한 점포를
 * 한 번에 닫는 것뿐이다. 조회는 check, 실행은 close 이고 둘 다 폐점 안 한 · 지우지 않은 점포만 넘긴다(조회는 openStoreWhere, 실행은 같은 조건의 lockOpenStoreIds). 막는 것은 퇴근 기록 없는
 * 출근 하나뿐이다(진행 중 계약은 폐점이 종료하고, 서명 완료 계약은 막지 않는다 — 2026-11-05 사용자 결정).
 */
@Injectable()
export class AdminWithdrawalService {
  private readonly logger = new Logger(AdminWithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeClosings: StoreClosingsService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
  ) {}

  async getEligibility(
    adminAccountId: number,
  ): Promise<WithdrawEligibilityResponseDto> {
    const account = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false },
      select: { roleTypeCode: true, bpCodeId: true, accountStatusCode: true },
    });
    // 탈퇴는 isDeleted 를 바꾸지 않는다 — 탈퇴 뒤 남은 접근 토큰으로 오면 execute 와 같이 404 다.
    if (!account || account.accountStatusCode === WITHDRAWN)
      throw new NotFoundException(NOT_FOUND);
    if (account.roleTypeCode !== BP_MASTER)
      throw new ForbiddenException(NOT_BP_MASTER);

    const { bpCodeId } = account;
    const bpCode = await findWithdrawableBp(this.prisma, bpCodeId);
    const [adminCount, storeIds] = await Promise.all([
      this.prisma.adminAccount.count({
        where: subAdminWhere(bpCodeId, adminAccountId),
      }),
      openStoreIds(this.prisma, bpCodeId),
    ]);
    const closing = await this.storeClosings.check(this.prisma, storeIds);

    return {
      bpName: bpCode.tradeName,
      adminCount,
      storeCount: storeIds.length,
      closing,
    };
  }

  /**
   * 탈퇴 실행. 확인(존재 · 역할 · 비밀번호 · 사유)을 모두 마친 뒤에만 쓴다. 본인은 탈퇴, 하위 관리자는
   * 미사용으로 상태를 바꾸고 둘 다 개인정보(이름 · 휴대폰 · 이메일)를 지운다 — isDeleted · loginId 는 그대로 둔다
   * (schema.prisma admin_accounts.isDeleted 주석). BP 는 상태와 대표자 연락처만 바꾸고 상호 · 사업자정보는
   * 남긴다. 점포는 마지막에 폐점 서비스(close)가 같은 트랜잭션에서 닫는다 — 잠금 순서는 BP 행 → admin_accounts 행 → 폐점할 점포 행 → 탈퇴
   * 처리 → close(직원 → 계정)이고, close 앞에서 staff_members · accounts 행을 잠그지 않는다. 폐점의 409(열린 출근 ·
   * 교착) · 503(시간 초과)은 그대로 내보내고 탈퇴째 되돌린다. 교착 재시도가 트랜잭션을 처음부터 다시 연다. 메일은 커밋 뒤
   * 지우기 전에 읽어 둔 이메일로 보내고, 실패해도 탈퇴를 되돌리지 않는다.
   */
  async execute(
    adminAccountId: number,
    dto: CreateWithdrawalDto,
  ): Promise<void> {
    const now = new Date();
    // 교착이면 트랜잭션을 처음부터 다시 연다(retryOnDeadlock 의 run 은 바깥 트랜잭션 없이 불러야 한다).
    const mailTarget = await retryOnDeadlock(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            // BP 행을 먼저 잠근다 — 하위 관리자 등록 · 수정(bp-admins lockBp 의 FOR SHARE)과 줄을 세워, 탈퇴 중에
            // 사용으로 저장한 계정도 탈퇴 시점 기준으로 모두 미사용이 되게 한다(그 저장은 탈퇴 뒤 409). 순서는 다른
            // 곳처럼 bp_codes → admin_accounts 다. 계정의 bp_code_id 는 바뀌지 않으므로 잠그기 전에 읽어도 된다.
            const owner = await tx.adminAccount.findFirst({
              where: { adminAccountId, isDeleted: false },
              select: { bpCodeId: true },
            });
            if (!owner) throw new NotFoundException(NOT_FOUND);
            await tx.$queryRaw`SELECT 1 FROM bp_codes WHERE bp_code_id = ${owner.bpCodeId} FOR UPDATE`;
            // 로그인 · 비밀번호 변경과 같은 행 잠금 — 같은 계정의 탈퇴가 겹쳐 들어와도 한 번만 처리된다.
            await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${adminAccountId} FOR UPDATE`;
            const account = await tx.adminAccount.findFirst({
              where: { adminAccountId, isDeleted: false },
              select: {
                roleTypeCode: true,
                bpCodeId: true,
                passwordHash: true,
                email: true,
                accountStatusCode: true,
              },
            });
            // 탈퇴는 isDeleted 를 바꾸지 않으므로 상태로도 거른다 — 두 번 탈퇴하면 이력 · 사유가 덮인다.
            if (!account || account.accountStatusCode === WITHDRAWN)
              throw new NotFoundException(NOT_FOUND);
            if (account.roleTypeCode !== BP_MASTER)
              throw new ForbiddenException(NOT_BP_MASTER);
            const { bpCodeId } = account;
            const bpCode = await findWithdrawableBp(tx, bpCodeId);
            if (
              !(await verifyPassword(dto.currentPassword, account.passwordHash))
            )
              throw new BadRequestException(
                ADMIN_PASSWORD_MESSAGES.currentMismatch,
              );

            const isInput = dto.reasonCode === WD_INPUT;
            const reasonDetail = isInput ? dto.reasonDetail?.trim() : undefined;
            if (isInput && !reasonDetail)
              throw new BadRequestException(REASON_DETAIL_REQUIRED);

            const subAdmins = await tx.adminAccount.findMany({
              where: subAdminWhere(bpCodeId, adminAccountId),
              select: { adminAccountId: true, accountStatusCode: true },
            });
            const storeIds = await lockOpenStoreIds(tx, bpCodeId);

            const erasedPersonal = {
              name: null,
              phone: null,
              email: null,
              updatedBy: adminAccountId,
            };
            const withdrawnPersonal = {
              ...erasedPersonal,
              accountStatusCode: WITHDRAWN,
              statusChangedAt: now,
            };
            const subAdminIds = subAdmins.map((admin) => admin.adminAccountId);
            await tx.adminAccount.update({
              where: { adminAccountId },
              data: {
                ...withdrawnPersonal,
                withdrawReasonCode: dto.reasonCode,
                withdrawReasonDetail: reasonDetail ?? null,
              },
            });
            // 사유는 본인 행에만 적는다 — 하위 관리자는 스스로 탈퇴한 것이 아니라 상태도 탈퇴가 아니라 미사용이다.
            // 읽은 id 로만 바꾼다 — 이력을 남긴 행과 바꾼 행이 늘 같다(그 사이 늘어난 계정을 이력 없이 바꾸지 않는다).
            // 개인정보는 모두 지우고, 상태는 사용이던 계정만 미사용으로 바꾼다(이미 미사용이면 바뀐 시각을 남겨 둔다).
            const activeSubIds = subAdmins
              .filter((admin) => admin.accountStatusCode === ACTIVE)
              .map((admin) => admin.adminAccountId);
            if (subAdminIds.length)
              await tx.adminAccount.updateMany({
                where: { adminAccountId: { in: subAdminIds } },
                data: erasedPersonal,
              });
            if (activeSubIds.length)
              await tx.adminAccount.updateMany({
                where: { adminAccountId: { in: activeSubIds } },
                data: { accountStatusCode: INACTIVE, statusChangedAt: now },
              });
            // 남은 접근 토큰으로 마이페이지에서 지운 개인정보를 다시 적지 못하게 본인 · 하위 관리자의 접속을 모두 끝낸다.
            await tx.adminSession.updateMany({
              where: {
                adminAccountId: { in: [adminAccountId, ...subAdminIds] },
                revokedAt: null,
              },
              data: { revokedAt: now },
            });

            await tx.bpCode.update({
              where: { bpCodeId },
              data: {
                accountStatusCode: WITHDRAWN,
                bizCeoPhone: null,
                bizCeoEmail: null,
                updatedBy: adminAccountId,
              },
            });

            // 계정 상태 이력 — BP 마스터는 탈퇴, 상태가 바뀐 하위 관리자(사용 → 미사용)만 미사용. 이미 미사용이던 계정은 상태가 그대로라 남기지 않는다.
            await tx.adminChangeHistory.createMany({
              data: [
                {
                  adminAccountId,
                  accountStatusCode: account.accountStatusCode,
                  after: WITHDRAWN_LABEL,
                },
                ...subAdmins
                  .filter((admin) => admin.accountStatusCode === ACTIVE)
                  .map((admin) => ({ ...admin, after: INACTIVE_LABEL })),
              ].map((target) => ({
                adminAccountId: target.adminAccountId,
                field: '계정 상태',
                beforeValue: accountStatusLabel(target.accountStatusCode),
                afterValue: target.after,
                changedBy: adminAccountId,
                changedAt: now,
              })),
            });

            await tx.bpChangeHistory.create({
              data: {
                bpCodeId,
                field: 'BP상태',
                beforeValue: accountStatusLabel(bpCode.accountStatusCode),
                afterValue: WITHDRAWN_LABEL,
                // schema.prisma bp_change_histories.note — 탈퇴 줄엔 탈퇴 사유.
                note: reasonDetail ?? WITHDRAW_REASON_LABEL[dto.reasonCode],
                changedBy: adminAccountId,
                changedAt: now,
              },
            });

            // 마지막에 닫는다 — 3팀 퇴직이 점포 → 직원 → 계정 순으로 잠그므로, 그 행을 이 앞에서 잡지 않는다.
            await this.storeClosings.close(tx, storeIds, adminAccountId, now);

            return { email: account.email, bpName: bpCode.tradeName };
          },
          { timeout: STORE_CLOSING_TRANSACTION_TIMEOUT_MS },
        ),
      `관리자 ${adminAccountId} 탈퇴`,
    );

    await this.sendWithdrawMail(adminAccountId, mailTarget, now);
  }

  /** 탈퇴 완료 메일. 이메일이 없거나 메일 설정이 없으면 보내지 않고, 실패는 기록만 한다 — 탈퇴는 이미 끝났다. */
  private async sendWithdrawMail(
    adminAccountId: number,
    target: { email: string | null; bpName: string },
    now: Date,
  ): Promise<void> {
    if (!this.mail || !target.email) return;
    try {
      await this.mail.send({
        templateCode: WITHDRAW_MAIL_TEMPLATE,
        to: target.email,
        variables: { BP이름: target.bpName, 탈퇴일: kstDateText(now) },
        adminAccountId,
      });
    } catch (error) {
      this.logger.error(
        `탈퇴 완료 메일 발송 실패(adminAccountId=${adminAccountId})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** 함께 미사용으로 바꾸고 개인정보를 지울 하위 관리자 — 같은 BP 의 본인 아닌, 지우지도 탈퇴하지도 않은 계정. */
function subAdminWhere(
  bpCodeId: number,
  adminAccountId: number,
): Prisma.AdminAccountWhereInput {
  return {
    bpCodeId,
    adminAccountId: { not: adminAccountId },
    isDeleted: false,
    accountStatusCode: { not: WITHDRAWN },
  };
}

/** 함께 강제 폐점할 점포 — 지우지 않은, 아직 폐점하지 않은 점포. lockOpenStoreIds 의 SQL 과 같은 조건이다 — 고치면 함께 고친다. */
function openStoreWhere(bpCodeId: number): Prisma.StoreWhereInput {
  return { bpCodeId, isDeleted: false, storeStatusCode: { not: CLOSED } };
}

/** 폐점 확인 · 저장에 넘길 점포 id — 이미 폐점했거나 지운 점포는 넣지 않는다. */
async function openStoreIds(db: Db, bpCodeId: number): Promise<number[]> {
  const stores = await db.store.findMany({
    where: openStoreWhere(bpCodeId),
    select: { storeId: true },
  });
  return stores.map((store) => store.storeId);
}

/**
 * 폐점할 점포를 읽으며 잠근다. 잠금을 기다린 뒤 PostgreSQL 이 조건을 다시 보므로, 그 사이 폐점 · 삭제된 점포는 빠져서 탈퇴를 409 · 404 로
 * 되돌리지 않는다. FOR UPDATE 가 아닌 까닭은 close 와 같다 — 외래키 잠금과 부딪치지 않게 한다. 조건은 openStoreWhere 와 같다.
 */
async function lockOpenStoreIds(
  tx: Prisma.TransactionClient,
  bpCodeId: number,
): Promise<number[]> {
  const rows = await tx.$queryRaw<
    { storeId: number }[]
  >`SELECT store_id AS "storeId" FROM stores WHERE bp_code_id = ${bpCodeId} AND NOT is_deleted AND store_status_code <> ${CLOSED} ORDER BY store_id FOR NO KEY UPDATE`;
  return rows.map((row) => row.storeId);
}

/**
 * 탈퇴할 BP. 플랫폼 BP(BP000000, 사용 고정)는 막는다 — 그 BP 에 BP 마스터 유형 계정이 생기면 이 연쇄가
 * 플랫폼 관리자 계정을 모두 탈퇴시킨다.
 */
async function findWithdrawableBp(
  db: Db,
  bpCodeId: number,
): Promise<{ tradeName: string; accountStatusCode: string }> {
  const bpCode = await db.bpCode.findUniqueOrThrow({
    where: { bpCodeId },
    select: { tradeName: true, accountStatusCode: true, isPlatform: true },
  });
  if (bpCode.isPlatform) throw new ForbiddenException(PLATFORM_BP);
  return bpCode;
}
