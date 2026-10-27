import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma } from '@prisma/client';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import type { OptionalMailService } from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import { retainEndDate, statusLabel } from '../stores/store-format';
import { ADMIN_PASSWORD_MESSAGES } from './admin-password-policy';
import type { WithdrawEligibilityResponseDto } from './dto/admin-withdrawal-eligibility.response.dto';
import type { CreateWithdrawalDto } from './dto/admin-withdrawal.dto';
import { verifyPassword } from './password';

const NOT_FOUND = '관리자 계정을 찾을 수 없습니다';
const NOT_BP_MASTER = 'BP 마스터만 탈퇴할 수 있습니다';
const REASON_DETAIL_REQUIRED = '탈퇴 사유 상세를 입력해 주세요.';
const IN_PROGRESS_CONTRACT =
  '진행 중인 근로계약이 있어 탈퇴할 수 없습니다. 근로계약을 모두 종료한 뒤 다시 시도해 주세요.';
const BP_MASTER = 'BM';
const WITHDRAWN = 'WITHDRAWN';
const CLOSED = 'CLOSED';
const WITHDRAWN_LABEL = '탈퇴';
const WITHDRAW_MAIL_TEMPLATE = 'EMAIL_WITHDRAW_DONE';

/** 탈퇴 전이라도 근로계약서가 끝까지 가지 않은 상태 — 있으면 BP 탈퇴를 막는다. */
const IN_PROGRESS_CONTRACT_STATUSES: ContractStatus[] = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'SIGNED',
];

/** 공통코드 WITHDRAW_REASON. 직접입력(WD_INPUT)만 상세를 받는다. */
const WITHDRAW_REASON_LABEL: Record<string, string> = {
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
 * 회원 탈퇴(MY PAGE S-JHQQNR). BP 마스터 본인만 받는다 — 탈퇴하면 같은 BP 의 하위 관리자(BP 관리자 ·
 * 가맹마스터 · 가맹관리자)도 함께 탈퇴하고 점포는 모두 강제 폐점된다(1팀 규칙, admin_accounts.statusChangedAt
 * 주석 참고). getEligibility 는 그 전에 보여줄 영향 범위만 세고, execute 가 실제로 탈퇴한다.
 *
 * contracts(3팀)는 1팀 stores 와 Prisma 관계로 잇지 않는다(schema.prisma 머리말 — storeId 는 정수 칸만 있다).
 * 그래서 이 BP 의 점포 id 를 먼저 받아 그 id 로 진행 중 계약을 센다(admin-scope.service.ts 의
 * storeId: { in: ... } 패턴과 같다). 두 메서드가 같은 countInProgressContracts 를 써서, 조회에서 탈퇴할 수
 * 있다고 한 요청을 실행이 다른 기준으로 막지 않는다.
 */
@Injectable()
export class AdminWithdrawalService {
  private readonly logger = new Logger(AdminWithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPTIONAL_MAIL_SERVICE) private readonly mail: OptionalMailService,
  ) {}

  async getEligibility(
    adminAccountId: number,
  ): Promise<WithdrawEligibilityResponseDto> {
    const account = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false },
      select: { roleTypeCode: true, bpCodeId: true },
    });
    if (!account) throw new NotFoundException(NOT_FOUND);
    if (account.roleTypeCode !== BP_MASTER)
      throw new ForbiddenException(NOT_BP_MASTER);

    const { bpCodeId } = account;
    const [bpCode, adminCount, storeCount, contractCount] = await Promise.all([
      this.prisma.bpCode.findUniqueOrThrow({
        where: { bpCodeId },
        select: { tradeName: true },
      }),
      this.prisma.adminAccount.count({
        where: subAdminWhere(bpCodeId, adminAccountId),
      }),
      this.prisma.store.count({ where: openStoreWhere(bpCodeId) }),
      countInProgressContracts(this.prisma, bpCodeId),
    ]);

    return {
      bpName: bpCode.tradeName,
      adminCount,
      storeCount,
      hasInProgressContract: contractCount > 0,
    };
  }

  /**
   * 탈퇴 실행. 확인(존재 · 역할 · 비밀번호 · 사유 · 진행 중 계약)을 모두 마친 뒤에만 쓴다. 본인 · 하위 관리자는
   * 상태만 탈퇴로 바꾸고 개인정보(이름 · 휴대폰 · 이메일)를 지운다 — isDeleted · loginId 는 그대로 둔다
   * (schema.prisma admin_accounts.isDeleted 주석). BP 는 상태와 대표자 연락처만 바꾸고 상호 · 사업자정보는
   * 남긴다. 메일은 커밋 뒤 지우기 전에 읽어 둔 이메일로 보내고, 실패해도 탈퇴를 되돌리지 않는다.
   */
  async execute(
    adminAccountId: number,
    dto: CreateWithdrawalDto,
  ): Promise<void> {
    const now = new Date();
    const mailTarget = await this.prisma.$transaction(async (tx) => {
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
      if (!(await verifyPassword(dto.currentPassword, account.passwordHash)))
        throw new BadRequestException(ADMIN_PASSWORD_MESSAGES.currentMismatch);

      const isInput = dto.reasonCode === WD_INPUT;
      const reasonDetail = isInput ? dto.reasonDetail?.trim() : undefined;
      if (isInput && !reasonDetail)
        throw new BadRequestException(REASON_DETAIL_REQUIRED);

      const { bpCodeId } = account;
      if ((await countInProgressContracts(tx, bpCodeId)) > 0)
        throw new BadRequestException(IN_PROGRESS_CONTRACT);

      const [bpCode, subAdmins, stores] = await Promise.all([
        tx.bpCode.findUniqueOrThrow({
          where: { bpCodeId },
          select: { tradeName: true, accountStatusCode: true },
        }),
        tx.adminAccount.findMany({
          where: subAdminWhere(bpCodeId, adminAccountId),
          select: { adminAccountId: true, accountStatusCode: true },
        }),
        tx.store.findMany({
          where: openStoreWhere(bpCodeId),
          select: { storeId: true, storeStatusCode: true },
        }),
      ]);

      const withdrawnPersonal = {
        accountStatusCode: WITHDRAWN,
        statusChangedAt: now,
        name: null,
        phone: null,
        email: null,
      };
      await tx.adminAccount.update({
        where: { adminAccountId },
        data: {
          ...withdrawnPersonal,
          withdrawReasonCode: dto.reasonCode,
          withdrawReasonDetail: reasonDetail ?? null,
        },
      });
      // 사유는 본인 행에만 적는다 — 하위 관리자는 스스로 탈퇴한 것이 아니다.
      if (subAdmins.length)
        await tx.adminAccount.updateMany({
          where: subAdminWhere(bpCodeId, adminAccountId),
          data: withdrawnPersonal,
        });

      await tx.bpCode.update({
        where: { bpCodeId },
        data: {
          accountStatusCode: WITHDRAWN,
          bizCeoPhone: null,
          bizCeoEmail: null,
        },
      });

      if (stores.length) {
        await tx.store.updateMany({
          where: { storeId: { in: stores.map((store) => store.storeId) } },
          data: { storeStatusCode: CLOSED, closedDate: now },
        });
        const retainUntil = retainEndDate(now);
        await tx.storeChangeHistory.createMany({
          data: stores.map((store) => ({
            storeId: store.storeId,
            field: '점포상태',
            beforeValue: statusLabel(store.storeStatusCode),
            afterValue: statusLabel(CLOSED),
            changedBy: adminAccountId,
            changedAt: now,
            retainEndDate: retainUntil,
          })),
        });
      }

      await tx.adminChangeHistory.createMany({
        data: [
          { adminAccountId, accountStatusCode: account.accountStatusCode },
          ...subAdmins,
        ].map((target) => ({
          adminAccountId: target.adminAccountId,
          field: '계정 상태',
          beforeValue: accountStatusLabel(target.accountStatusCode),
          afterValue: WITHDRAWN_LABEL,
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

      return { email: account.email, bpName: bpCode.tradeName };
    });

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

/** 함께 탈퇴할 하위 관리자 — 같은 BP 의 본인 아닌, 지우지도 탈퇴하지도 않은 계정. */
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

/** 함께 강제 폐점할 점포 — 지우지 않은, 아직 폐점하지 않은 점포. */
function openStoreWhere(bpCodeId: number): Prisma.StoreWhereInput {
  return { bpCodeId, isDeleted: false, storeStatusCode: { not: CLOSED } };
}

/** 이 BP 의 모든 점포(지운 · 폐점한 점포 포함)에 걸린 진행 중 근로계약 수. */
async function countInProgressContracts(
  db: Db,
  bpCodeId: number,
): Promise<number> {
  const stores = await db.store.findMany({
    where: { bpCodeId },
    select: { storeId: true },
  });
  return db.contract.count({
    where: {
      storeId: { in: stores.map((store) => store.storeId) },
      status: { in: IN_PROGRESS_CONTRACT_STATUSES },
    },
  });
}
