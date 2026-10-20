import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EmploymentType, Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
  ManageableStores,
} from '../admin-scope/admin-scope.service';
import { HQ_SHARING_CONSENTED } from '../admin-scope/hq-sharing';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, kstDayStart } from '../staff-members/kst-date';
import {
  PayslipBulkCreateResponseDto,
  PayslipCandidatesResponseDto,
  PayslipCreatedDto,
} from './dto/payslip-draft.response.dto';
import { dateOnly, monthRange, storeNames } from './payslip-shared';

/** 급여 기간 — 그 달 1일 ~ 말일. 근로계약의 임금지급 월 · 일은 언제 주는지일 뿐 셈하는 기간을 바꾸지 않는다. */
function payPeriod(month: string) {
  const { gte, lt } = monthRange(month);
  return { start: gte, end: addDays(lt, -1), next: lt };
}
type Period = ReturnType<typeof payPeriod>;

/** 급여 기간에 효력이 있는 근로계약 — 체결 완료이고 계약 기간이 급여 기간과 겹친다(종료일 없음은 무기한). */
const validContractWhere = (p: Period) =>
  ({
    status: 'SIGNED',
    startDate: { lte: p.end },
    OR: [{ endDate: null }, { endDate: { gte: p.start } }],
  }) satisfies Prisma.ContractWhereInput;

/** 이 달 명세서 — 목록(GET /payslips)과 같이 급여 기간 시작일이 그 달인 것. */
const monthPayslipWhere = (month: string) =>
  ({ periodStartDate: monthRange(month) }) satisfies Prisma.PayslipWhereInput;

const MISSING_ATTENDANCE_DETAIL = '급여 기간에 출퇴근 기록이 없습니다';

/** 새 명세서에 처음부터 서는 항목 구분. 추가 공제(ADDITIONAL)는 검토 화면에서 붙인다. */
const DRAFT_CATEGORIES = ['EARNING', 'BASIC', 'WITHHOLDING'] as const;

interface Candidate {
  staffMemberId: number;
  staffName: string;
  storeId: number;
  employmentType: EmploymentType;
  /** 급여 기간에 걸친 유효 계약, 가장 늦게 시작한 것부터 */
  contractIds: number[];
  payslipId: number | null;
  hasAttendance: boolean;
}

type Master = {
  payslipItemMasterId: number;
  name: string;
  category: (typeof DRAFT_CATEGORIES)[number] | 'ADDITIONAL';
  isTaxFree: boolean;
};

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const exists = (payslipId?: number) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'PAYSLIP_EXISTS',
    message: '이 직원의 이 달 급여명세서가 이미 있습니다',
    ...(payslipId && { payslipId }),
  });

/**
 * 급여명세서 초안 작성 (WHALEERP-226). 근로계약과 출퇴근 기록을 참고해 작성 중 상태의 초안을 만든다 — 금액 계산
 * (기본급 · 주휴수당 · 연장수당, WHALEERP-227)은 아직 없어 항목은 금액 없이 미입력으로 선다.
 *
 * 범위는 목록과 같은 관리 범위이고, 본사 역할(BM · BA)에게 본사 제공 동의 없는 가맹 점포 직원은 작성 대상에서 빠진다
 * (ATT-30 — 명세서는 직원 개인 정보다. 그 직원 명세서는 가맹 쪽 관리자가 만든다). 하나만 만들 때 그 직원은 404 다.
 */
@Injectable()
export class PayslipDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 작성 대상. 관리자 계정이 없거나 사용 중이 아니면 null(컨트롤러가 403). */
  async candidates(
    adminAccountId: number,
    month: string,
  ): Promise<PayslipCandidatesResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) return null;
    const period = payPeriod(month);
    const list = await this.loadCandidates(manageable, month);
    const names = await storeNames(
      this.prisma,
      list.map((c) => c.storeId),
    );
    return {
      periodStartDate: dateOnly(period.start),
      periodEndDate: dateOnly(period.end),
      items: list.map(({ contractIds, ...c }) => ({
        ...c,
        storeName: names(c.storeId),
        contractId: contractIds[0] ?? null,
      })),
    };
  }

  /**
   * 직원 한 명의 초안. 관리자 계정이 사용 중이 아니면 null(403). 범위 밖 · 가려지는 · 없는 직원 404,
   * 이 달 명세서가 있으면 409 PAYSLIP_EXISTS, 유효한 계약이 없으면 422 NO_VALID_CONTRACT.
   */
  async create(
    adminAccountId: number,
    staffMemberId: number,
    month: string,
  ): Promise<PayslipCreatedDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) return null;
    const [candidate] = await this.loadCandidates(
      manageable,
      month,
      staffMemberId,
    );
    if (!candidate) throw new NotFoundException('직원을 찾을 수 없습니다');
    if (candidate.payslipId !== null) throw exists(candidate.payslipId);
    if (candidate.contractIds.length === 0)
      throw new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Unprocessable Entity',
        code: 'NO_VALID_CONTRACT',
        message: '급여 기간에 유효한 근로계약이 없어 초안을 만들 수 없습니다',
      });
    const masters = await this.loadMasters();
    try {
      const payslipId = await this.createDraft(
        adminAccountId,
        candidate,
        month,
        masters,
      );
      return { payslipId };
    } catch (e) {
      if (isUniqueViolation(e)) throw exists();
      throw e;
    }
  }

  /**
   * 관리 범위의 작성 대상 모두. 이미 있음 · 계약 없음은 건너뛴다. 직원마다 따로 트랜잭션이라 중간에 실패해도 앞서
   * 만든 초안은 남는다 — 다시 돌리면 이미 있음으로 건너뛰므로 이어서 만든다.
   */
  async bulkCreate(
    adminAccountId: number,
    month: string,
  ): Promise<PayslipBulkCreateResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) return null;
    const list = await this.loadCandidates(manageable, month);
    const result: PayslipBulkCreateResponseDto = { created: [], skipped: [] };
    const skip = (c: Candidate, reason: 'EXISTS' | 'NO_CONTRACT') =>
      result.skipped.push({
        staffMemberId: c.staffMemberId,
        staffName: c.staffName,
        reason,
      });
    const creatable = list.filter((c) => {
      if (c.payslipId !== null) skip(c, 'EXISTS');
      else if (c.contractIds.length === 0) skip(c, 'NO_CONTRACT');
      else return true;
      return false;
    });
    if (creatable.length === 0) return result;

    const masters = await this.loadMasters();
    for (const c of creatable) {
      try {
        const payslipId = await this.createDraft(
          adminAccountId,
          c,
          month,
          masters,
        );
        result.created.push({
          payslipId,
          staffMemberId: c.staffMemberId,
          staffName: c.staffName,
          hasMissingAttendance: !c.hasAttendance,
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        skip(c, 'EXISTS');
      }
    }
    return result;
  }

  /**
   * 관리 범위의 직원과 그 달의 유효 계약 · 명세서 · 출퇴근 기록 유무. 직원을 정하지 않으면 재직 중이거나 그 달 유효
   * 계약 · 명세서가 있는 직원만이다(오래전 퇴직자는 빠진다). 본사 역할에게 가려지는 직원은 쿼리에서 뺀다.
   */
  private async loadCandidates(
    { stores, roleTypeCode }: ManageableStores,
    month: string,
    staffMemberId?: number,
  ): Promise<Candidate[]> {
    if (stores.length === 0) return [];
    const period = payPeriod(month);
    const masked = stores.filter((s) =>
      hidesPersonalData(roleTypeCode, s.storeTypeCode, false),
    );
    const open = stores.filter((s) => !masked.includes(s));
    const ids = (list: typeof stores) => list.map((s) => s.storeId);
    const scopeWhere: Prisma.StaffMemberWhereInput = {
      OR: [
        ...(open.length > 0 ? [{ storeId: { in: ids(open) } }] : []),
        ...(masked.length > 0
          ? [{ storeId: { in: ids(masked) }, ...HQ_SHARING_CONSENTED }]
          : []),
      ],
    };
    const contracts = validContractWhere(period);
    const payslips = monthPayslipWhere(month);
    const rows = await this.prisma.staffMember.findMany({
      where: {
        AND: [
          scopeWhere,
          staffMemberId !== undefined
            ? { staffMemberId }
            : {
                OR: [
                  { employmentStatus: 'EMPLOYED' },
                  { contracts: { some: contracts } },
                  { payslips: { some: payslips } },
                ],
              },
        ],
      },
      orderBy: [{ name: 'asc' }, { staffMemberId: 'asc' }],
      select: {
        staffMemberId: true,
        storeId: true,
        name: true,
        employmentType: true,
        contracts: {
          where: contracts,
          orderBy: [{ startDate: 'desc' }, { contractId: 'desc' }],
          select: { contractId: true, employmentType: true },
        },
        payslips: { where: payslips, select: { payslipId: true } },
      },
    });
    if (rows.length === 0) return [];

    const attended = await this.prisma.attendanceRecord.findMany({
      where: {
        staffMemberId: { in: rows.map((r) => r.staffMemberId) },
        recordedAt: {
          gte: kstDayStart(period.start),
          lt: kstDayStart(period.next),
        },
      },
      distinct: ['staffMemberId'],
      select: { staffMemberId: true },
    });
    const hasAttendance = new Set(attended.map((a) => a.staffMemberId));
    return rows.map((r) => ({
      staffMemberId: r.staffMemberId,
      staffName: r.name,
      storeId: r.storeId,
      employmentType: r.contracts[0]?.employmentType ?? r.employmentType,
      contractIds: r.contracts.map((c) => c.contractId),
      payslipId: r.payslips[0]?.payslipId ?? null,
      hasAttendance: hasAttendance.has(r.staffMemberId),
    }));
  }

  private loadMasters(): Promise<Master[]> {
    return this.prisma.payslipItemMaster.findMany({
      where: { isActive: true, category: { in: [...DRAFT_CATEGORIES] } },
      orderBy: [{ sortOrder: 'asc' }, { payslipItemMasterId: 'asc' }],
      select: {
        payslipItemMasterId: true,
        name: true,
        category: true,
        isTaxFree: true,
      },
    });
  }

  /**
   * 초안 한 장을 한 트랜잭션에서 만든다 — 명세서 · 항목 · 검토 사유 · 처리 이력. 가산 · 3.3% 는 같은 직원의 지난 명세서
   * 값으로 시작하고, 없으면 가산 적용(PAY-05), 파트타이머 3.3% 적용(PAY-03)이다. 3.3% 는 지난 명세서도 파트타이머일
   * 때만 가져온다. 정직원은 원천징수 항목 없이 3.3% 꺼짐이다. 금액은 모두 0 이라 실지급액 CHECK(지급 − 공제)가 맞는다.
   */
  private createDraft(
    adminAccountId: number,
    c: Candidate,
    month: string,
    masters: Master[],
  ): Promise<number> {
    const period = payPeriod(month);
    const partTime = c.employmentType === 'PART_TIME';
    const reasons: Prisma.PayslipReviewReasonCreateManyPayslipInput[] = [];
    if (!c.hasAttendance)
      reasons.push({
        reviewReason: 'MISSING_ATTENDANCE',
        detail: MISSING_ATTENDANCE_DETAIL,
      });
    if (c.contractIds.length > 1)
      reasons.push({
        reviewReason: 'CONTRACT_CHANGED',
        detail: `급여 기간에 근로계약이 ${c.contractIds.length}건 걸쳐 있어 가장 늦게 시작한 계약을 참조했습니다`,
      });

    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.payslip.findFirst({
        where: {
          staffMemberId: c.staffMemberId,
          periodStartDate: { lt: period.start },
        },
        orderBy: [{ periodStartDate: 'desc' }, { payslipId: 'desc' }],
        select: {
          isPremiumApplied: true,
          isWithholdingApplied: true,
          employmentType: true,
        },
      });
      const { payslipId } = await tx.payslip.create({
        data: {
          staffMemberId: c.staffMemberId,
          storeId: c.storeId,
          contractId: c.contractIds[0],
          periodStartDate: period.start,
          periodEndDate: period.end,
          employmentType: c.employmentType,
          attendanceStartDate: period.start,
          attendanceEndDate: period.end,
          status: 'DRAFTING',
          isPremiumApplied: previous?.isPremiumApplied ?? true,
          isWithholdingApplied:
            partTime &&
            (previous?.employmentType === 'PART_TIME'
              ? previous.isWithholdingApplied
              : true),
          grossPayAmount: 0,
          totalDeductionAmount: 0,
          netPayAmount: 0,
          payslipItems: {
            createMany: {
              data: masters
                .filter((m) => partTime || m.category !== 'WITHHOLDING')
                .map((m) => ({
                  payslipItemMasterId: m.payslipItemMasterId,
                  itemCategory: m.category,
                  itemName: m.name,
                  isTaxFree: m.isTaxFree,
                  calculatedAmount: null,
                  adjustedAmount: null,
                  isEntered: false,
                })),
            },
          },
          payslipReviewReasons: { createMany: { data: reasons } },
          payslipLogs: {
            create: {
              logType: 'DRAFT',
              fromStatus: null,
              toStatus: 'DRAFTING',
              summary: '초안 생성',
              changedBy: adminAccountId,
            },
          },
        },
        select: { payslipId: true },
      });
      return payslipId;
    });
  }
}
