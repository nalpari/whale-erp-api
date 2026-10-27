import { Injectable } from '@nestjs/common';
import {
  PayslipReviewReasonValue,
  PayslipStatus,
  Prisma,
} from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { adminNames } from '../common/admin-names';
import { containsText } from '../common/contains-text';
import { PrismaService } from '../prisma/prisma.service';
import { PayslipListQueryDto } from './dto/payslip-list.query.dto';
import {
  PayslipDetailResponseDto,
  PayslipListItemDto,
  PayslipListResponseDto,
  PayslipStatusCountsDto,
} from './dto/payslip.response.dto';
import {
  dateOnly,
  ITEM_ORDER,
  monthRange,
  pickedStores,
  storeNames,
} from './payslip-shared';

const STATUSES = Object.values(PayslipStatus);

/**
 * 검토 대기 사유 넷 — 이 순서로 보인다(WHALEERP-234). 공제 미입력(DEDUCTION_MISSING)은 사유로 남기지 않고 확정만 막는다.
 */
export const REVIEW_PENDING_REASONS = [
  'MISSING_ATTENDANCE',
  'AFTER_CONTRACT_END',
  'CONTRACT_CHANGED',
  'ATTENDANCE_NEEDS_REVIEW',
] as const satisfies readonly PayslipReviewReasonValue[];

/** 검토 대기 — 확인하지 않은 검토 사유가 남은 명세서(검토 대기는 상태가 아니라 분류다, 2026-10-26) */
const REVIEW_PENDING: Prisma.PayslipWhereInput = {
  payslipReviewReasons: {
    some: {
      acknowledgedAt: null,
      reviewReason: { in: [...REVIEW_PENDING_REASONS] },
    },
  },
};

/** 출퇴근 누락 사유가 없거나 모두 확인됐으면 출퇴근 확인. */
const attendanceConfirmed = (
  reasons: { reviewReason: PayslipReviewReasonValue }[],
) => !reasons.some((r) => r.reviewReason === 'MISSING_ATTENDANCE');

/** 확인하지 않은 검토 사유를 정해진 순서로, 한 번씩 */
const pendingReasonsOf = (
  reasons: { reviewReason: PayslipReviewReasonValue }[],
) =>
  REVIEW_PENDING_REASONS.filter((code) =>
    reasons.some((r) => r.reviewReason === code),
  );

const LIST_SELECT = {
  payslipId: true,
  storeId: true,
  periodStartDate: true,
  periodEndDate: true,
  employmentType: true,
  status: true,
  staffMember: { select: { name: true, ...HQ_SHARING_SELECT } },
  // 확인하지 않은 사유만 — 출퇴근 확인 여부와 검토 대기 사유를 함께 낸다
  payslipReviewReasons: {
    where: { acknowledgedAt: null },
    select: { reviewReason: true },
  },
  payslipDispatches: {
    where: { status: 'SUCCEEDED' },
    orderBy: [{ sentAt: 'desc' }, { payslipDispatchId: 'desc' }],
    take: 1,
    select: { sentAt: true },
  },
} satisfies Prisma.PayslipSelect;

const DETAIL_SELECT = {
  payslipId: true,
  staffMemberId: true,
  storeId: true,
  contractId: true,
  periodStartDate: true,
  periodEndDate: true,
  employmentType: true,
  attendanceStartDate: true,
  attendanceEndDate: true,
  status: true,
  isPremiumApplied: true,
  isWithholdingApplied: true,
  grossPayAmount: true,
  totalDeductionAmount: true,
  netPayAmount: true,
  confirmedAt: true,
  createdAt: true,
  updatedAt: true,
  staffMember: { select: { name: true } },
  contract: { select: { contractId: true, status: true, wageAmount: true } },
  payslipItems: {
    orderBy: ITEM_ORDER,
    select: {
      payslipItemId: true,
      itemCategory: true,
      payslipItemMasterId: true,
      itemName: true,
      isTaxFree: true,
      calculatedAmount: true,
      adjustedAmount: true,
      isEntered: true,
      payslipItemMaster: { select: { itemCode: true } },
    },
  },
  payslipReviewReasons: {
    orderBy: { payslipReviewReasonId: 'asc' },
    select: {
      payslipReviewReasonId: true,
      reviewReason: true,
      detail: true,
      acknowledgedAt: true,
    },
  },
  payslipLogs: {
    orderBy: [{ changedAt: 'desc' }, { payslipLogId: 'desc' }],
    select: {
      payslipLogId: true,
      logType: true,
      fromStatus: true,
      toStatus: true,
      summary: true,
      changedBy: true,
      changedAt: true,
    },
  },
  payslipDispatches: {
    orderBy: [{ sentAt: 'asc' }, { payslipDispatchId: 'asc' }],
    select: {
      payslipDispatchId: true,
      channel: true,
      status: true,
      sentAt: true,
    },
  },
} satisfies Prisma.PayslipSelect;

const zeroCounts = (): PayslipStatusCountsDto => ({
  DRAFTING: 0,
  REVIEWING: 0,
  CONFIRMED: 0,
  SENT: 0,
});

/**
 * 급여명세서 관리 목록 · 상세(WHALEERP-330). 근무지 범위는 관리자의 관리 범위(AdminScopeService)이고, 본사 역할의
 * 가림(hidesPersonalData)은 직원 목록 · 상세와 같은 기준이다 — 가맹 점포에서 본사 제공 동의를 하지 않은 직원의
 * 명세서는 목록에서 근무지 · 급여 기간만 남기고, 상세는 404 다.
 */
@Injectable()
export class PayslipListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 목록. 관리자 계정이 없거나 사용 중이 아니면 null(컨트롤러가 403). */
  async list(
    adminAccountId: number,
    query: PayslipListQueryDto,
  ): Promise<PayslipListResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) return null;
    const { roleTypeCode } = manageable;
    // 점포 · 점포 유형을 고르면 관리 범위 안에서 좁힌다. 범위 밖 ID 는 조용히 빠진다(직원 목록과 같다).
    const stores = await pickedStores(
      this.prisma,
      manageable.stores,
      query.storeIds,
      query.storeTypes,
    );
    if (stores.length === 0)
      return {
        items: [],
        total: 0,
        statusCounts: zeroCounts(),
        reviewPendingCount: 0,
      };

    const ids = (list: typeof stores) => list.map((s) => s.storeId);
    const allStores = { storeId: { in: ids(stores) } };
    const period = { periodStartDate: monthRange(query.month) };
    // 가린 줄의 상태 · 이름으로 거르면 그 줄의 상태가 드러나거나 이름이 맞는지 드러난다. 상태나 직원명으로 거를 때
    // 본사 역할에게는, 동의하지 않은 직원이 가려지는 점포에서 동의한 직원 명세서만 남긴다 — 직원 목록의 개인 칸
    // 필터와 같다. 네 상태를 모두 고른 것은 거르지 않은 것과 같다. 상태 건수는 상태 필터와 상관없이 가린 줄도 센다
    // (ATT-30 — 건수는 개인 단위가 아니다). 다만 직원명으로 거르면 건수도 그 이름 · 가림 조건을 따른다 — 건수로 가린
    // 직원에게 그 이름의 명세서가 있는지 드러나지 않게.
    const status = query.status && [...new Set(query.status)];
    const filtersStatus = !!status && status.length < STATUSES.length;
    const name: Prisma.PayslipWhereInput | null = query.staffName
      ? { staffMember: { name: containsText(query.staffName) } }
      : null;
    const masking = stores.filter((s) =>
      hidesPersonalData(roleTypeCode, s.storeTypeCode, false),
    );
    const consentedOnly: Prisma.PayslipWhereInput =
      masking.length > 0
        ? {
            OR: [
              {
                storeId: {
                  in: ids(stores.filter((s) => !masking.includes(s))),
                },
              },
              {
                storeId: { in: ids(masking) },
                staffMember: HQ_SHARING_CONSENTED,
              },
            ],
          }
        : allStores;
    // 검토 대기로 거르는 것도 개인 칸 필터다 — 가린 줄이 검토 대기인지 드러나지 않게 상태 필터처럼 동의한 직원만 남긴다
    const pendingOnly = query.reviewPending === true;
    const where: Prisma.PayslipWhereInput = {
      AND: [
        filtersStatus || name || pendingOnly ? consentedOnly : allStores,
        period,
        ...(name ? [name] : []),
        ...(filtersStatus ? [{ status: { in: status } }] : []),
        ...(pendingOnly ? [REVIEW_PENDING] : []),
      ],
    };
    const countWhere: Prisma.PayslipWhereInput = name
      ? { AND: [consentedOnly, period, name] }
      : { ...allStores, ...period };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [rows, total, grouped, reviewPendingCount] =
      await this.prisma.$transaction([
        this.prisma.payslip.findMany({
          where,
          // 화면은 직원 이름순이다. 가린 줄도 이름 자리에 선다 — 이름 첫 글자 언저리가 드러나는 것은 받아들인다.
          orderBy: [{ staffMember: { name: 'asc' } }, { payslipId: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: LIST_SELECT,
        }),
        this.prisma.payslip.count({ where }),
        this.prisma.payslip.groupBy({
          by: ['status'],
          where: countWhere,
          _count: { _all: true },
          // 트랜잭션 배열 안의 groupBy 는 orderBy 가 없으면 타입이 맞지 않는다(Prisma).
          orderBy: { status: 'asc' },
        }),
        // 검토 대기 건수도 상태 건수와 같은 범위로 센다(건수는 개인 단위가 아니다 — ATT-30)
        this.prisma.payslip.count({
          where: { AND: [countWhere, REVIEW_PENDING] },
        }),
      ]);
    const statusCounts = zeroCounts();
    // 트랜잭션 배열 안에서는 groupBy 결과 타입이 _count 를 좁히지 못해 모양을 붙인다.
    for (const g of grouped as {
      status: PayslipStatus;
      _count: { _all: number };
    }[])
      statusCounts[g.status] = g._count._all;
    if (rows.length === 0)
      return { items: [], total, statusCounts, reviewPendingCount };

    const names = await storeNames(
      this.prisma,
      rows.map((r) => r.storeId),
    );
    const typeById = new Map(stores.map((s) => [s.storeId, s.storeTypeCode]));
    const items = rows.map((r): PayslipListItemDto => {
      const shown = {
        storeId: r.storeId,
        storeName: names(r.storeId),
        periodStartDate: dateOnly(r.periodStartDate),
        periodEndDate: dateOnly(r.periodEndDate),
      };
      if (
        hidesPersonalData(
          roleTypeCode,
          typeById.get(r.storeId),
          hqSharingConsentedOf(r.staffMember),
        )
      )
        return {
          ...shown,
          payslipId: null,
          isMasked: true,
          staffName: null,
          employmentType: null,
          isAttendanceConfirmed: null,
          status: null,
          lastSentAt: null,
          pendingReviewReasons: null,
        };
      return {
        ...shown,
        payslipId: r.payslipId,
        isMasked: false,
        staffName: r.staffMember.name,
        employmentType: r.employmentType,
        isAttendanceConfirmed: attendanceConfirmed(r.payslipReviewReasons),
        status: r.status,
        lastSentAt: r.payslipDispatches[0]?.sentAt ?? null,
        pendingReviewReasons: pendingReasonsOf(r.payslipReviewReasons),
      };
    });
    return { items, total, statusCounts, reviewPendingCount };
  }

  /**
   * 상세. 없거나 관리 범위 밖이거나 가려지는 명세서면 null — 셋을 가르지 않는다(컨트롤러가 모두 같은 404). 가림은
   * 나머지를 읽기 전에 정한다 — 읽은 뒤에 거르면 가려지는 명세서의 404 만 늦어 응답 시간으로 드러난다(직원 상세와 같다).
   */
  async findOne(
    adminAccountId: number,
    payslipId: number,
  ): Promise<PayslipDetailResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) return null;
    const found = await this.prisma.payslip.findFirst({
      where: {
        payslipId,
        storeId: { in: manageable.stores.map((s) => s.storeId) },
      },
      select: {
        storeId: true,
        staffMember: { select: HQ_SHARING_SELECT },
      },
    });
    if (
      !found ||
      hidesPersonalData(
        manageable.roleTypeCode,
        manageable.stores.find((s) => s.storeId === found.storeId)
          ?.storeTypeCode,
        hqSharingConsentedOf(found.staffMember),
      )
    )
      return null;

    const [p, names] = await Promise.all([
      this.prisma.payslip.findUniqueOrThrow({
        where: { payslipId },
        select: DETAIL_SELECT,
      }),
      storeNames(this.prisma, [found.storeId]),
    ]);
    const changedByName = await adminNames(
      this.prisma,
      p.payslipLogs.map((l) => l.changedBy),
    );
    return {
      payslipId: p.payslipId,
      staffMemberId: p.staffMemberId,
      staffName: p.staffMember.name,
      storeId: p.storeId,
      storeName: names(p.storeId),
      contractId: p.contractId,
      periodStartDate: dateOnly(p.periodStartDate),
      periodEndDate: dateOnly(p.periodEndDate),
      employmentType: p.employmentType,
      status: p.status,
      isPremiumApplied: p.isPremiumApplied,
      isWithholdingApplied: p.isWithholdingApplied,
      grossPayAmount: p.grossPayAmount,
      totalDeductionAmount: p.totalDeductionAmount,
      netPayAmount: p.netPayAmount,
      attendanceStartDate: dateOnly(p.attendanceStartDate),
      attendanceEndDate: dateOnly(p.attendanceEndDate),
      isAttendanceConfirmed: attendanceConfirmed(
        p.payslipReviewReasons.filter(
          (r) => r.reviewReason === 'MISSING_ATTENDANCE',
        ),
      ),
      confirmedAt: p.confirmedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      contract: p.contract,
      items: p.payslipItems.map(({ payslipItemMaster, ...item }) => ({
        ...item,
        itemCode: payslipItemMaster.itemCode,
      })),
      reviewReasons: p.payslipReviewReasons,
      logs: p.payslipLogs.map((l) => ({
        ...l,
        changedByName: changedByName.get(l.changedBy) ?? null,
      })),
      dispatches: p.payslipDispatches,
    };
  }
}
