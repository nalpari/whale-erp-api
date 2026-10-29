import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import { MyPayslipListQueryDto } from './dto/my-payslip-list.query.dto';
import {
  MyPayslipDetailResponseDto,
  MyPayslipListResponseDto,
  MyPayslipSummaryDto,
} from './dto/my-payslip.response.dto';
import { dateOnly, ITEM_ORDER, storeNames } from './payslip-shared';

/** PAY-4: 퇴직한 뒤에도 명세서를 만든 날부터 3년 동안 본다. */
const RETENTION_YEARS = 3;

const SUMMARY_SELECT = {
  payslipId: true,
  storeId: true,
  periodStartDate: true,
  periodEndDate: true,
  employmentType: true,
  status: true,
  grossPayAmount: true,
  totalDeductionAmount: true,
  netPayAmount: true,
  createdAt: true,
  // 초안 · 수정 · 확정은 관리자 쪽 이력이라 직원에게 보이지 않는다(PAY-1).
  payslipLogs: {
    where: { logType: { in: ['SEND', 'CANCEL_CONFIRMATION'] } },
    orderBy: [{ changedAt: 'desc' }, { payslipLogId: 'desc' }],
    select: { payslipLogId: true, logType: true, changedAt: true },
  },
} satisfies Prisma.PayslipSelect;

export const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  isWithholdingApplied: true,
  // 상세 응답에는 싣지 않는다 — PDF 의 직원 이름 · 파일 이름에만 쓴다
  staffMember: { select: { name: true } },
  payslipItems: {
    orderBy: ITEM_ORDER,
    select: {
      payslipItemId: true,
      itemCategory: true,
      itemName: true,
      isTaxFree: true,
      calculatedAmount: true,
      adjustedAmount: true,
      isEntered: true,
      payslipItemMaster: { select: { itemCode: true } },
    },
  },
} satisfies Prisma.PayslipSelect;

type SummaryRow = Prisma.PayslipGetPayload<{ select: typeof SUMMARY_SELECT }>;

/**
 * 직원 근무 앱의 내 급여명세서(WHALEERP-330). 로그인한 계정의 직원 레코드(점포가 여럿이면 모두)에 발송된 명세서만,
 * 만든 날부터 3년 안의 것만 준다 — 재직 상태는 보지 않아 퇴직한 뒤에도 보인다(PAY-4). 발송 뒤 확정을 취소한 명세서는
 * 목록에 남기고 「검토 중」(correcting)으로 표시한다 — 금액 · 항목은 다시 보낼 때까지 싣지 않는다. 이전 발송 값을 남기는
 * 칸이 없어, 실으면 관리자가 고치는 중인 값을 보이게 된다(2026-10-21 사용자 결정).
 */
@Injectable()
export class MyPayslipsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 목록. 받은 명세서는 근무지와 관계없이 모두 보인다(PAY-8). 맨 위 이번 달 합계와 점포 목록은 필터 전 전체로 세고,
   * items 만 점포 · 연도(급여 기간)로 거른다(PAY-9 · PAY-10). 순서는 급여 기간 최신순, 같은 달이면 받은 날(가장 최근
   * 발송, 다시 보냈으면 다시 보낸 날 — PAY-1 · PAY-20) 최신순이다 — 정정해 다시 보낸 지난달 명세서가 이번 달 위로 오지 않게
   * (PAY-8, 2026-10-22 재영). 보존 기간 3년 안의 것이라 한 사람 몫을 한 번에 읽는다.
   */
  async list(
    accountId: number,
    query: MyPayslipListQueryDto = {},
    now: Date = new Date(),
  ): Promise<MyPayslipListResponseDto> {
    const rows = await this.prisma.payslip.findMany({
      where: myPayslipWhere(accountId, now),
      select: SUMMARY_SELECT,
    });
    const names =
      rows.length > 0
        ? await storeNames(
            this.prisma,
            rows.map((r) => r.storeId),
          )
        : () => '';
    const all = rows
      .map((r) => toSummary(r, names(r.storeId)))
      .sort(
        (a, b) =>
          b.periodStartDate.localeCompare(a.periodStartDate) ||
          (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0) ||
          b.payslipId - a.payslipId,
      );

    const month = kstMonth(now);
    // 검토 중인 명세서는 금액을 모르니 합계에서 뺀다 — 다시 보내면 그 달에 받은 것으로 센다
    const received = all.filter(
      (p) => !p.correcting && p.sentAt && kstMonth(p.sentAt) === month,
    );
    const stores = [
      ...new Map(all.map((p) => [p.storeId, p.storeName])).entries(),
    ]
      .map(([storeId, storeName]) => ({ storeId, storeName }))
      .sort((a, b) => a.storeName.localeCompare(b.storeName, 'ko'));

    return {
      thisMonth: {
        month,
        count: received.length,
        totalNetPayAmount: received.reduce(
          (sum, p) => sum + (p.netPayAmount ?? 0),
          0,
        ),
        // 목록(all)은 급여 기간순이라 점포 이름은 받은 날순으로 다시 세운다 — 최근에 받은 것부터
        storeNames: [
          ...new Set(
            [...received]
              .sort((a, b) => b.sentAt!.getTime() - a.sentAt!.getTime())
              .map((p) => p.storeName),
          ),
        ],
      },
      stores,
      items: all.filter(
        (p) =>
          (query.storeId === undefined || p.storeId === query.storeId) &&
          (query.year === undefined ||
            Number(p.periodStartDate.slice(0, 4)) === query.year),
      ),
    };
  }

  /** 한 장. 없거나 남의 것 · 발송 전 · 보존 기간이 지난 것이면 null(컨트롤러가 404). 검토 중이면 항목 없이 준다. */
  async findOne(
    accountId: number,
    payslipId: number,
    now: Date = new Date(),
  ): Promise<MyPayslipDetailResponseDto | null> {
    return (await this.document(accountId, payslipId, now))?.detail ?? null;
  }

  /**
   * PDF 내보내기(PAY-2)용 — 상세와 같은 조건 · 같은 값에 직원 이름을 더한다. 없거나 남의 것 · 발송 전 · 보존 기간이
   * 지난 것이면 null(컨트롤러가 404).
   */
  async document(
    accountId: number,
    payslipId: number,
    now: Date = new Date(),
  ): Promise<{ detail: MyPayslipDetailResponseDto; staffName: string } | null> {
    const row = await this.prisma.payslip.findFirst({
      where: { payslipId, ...myPayslipWhere(accountId, now) },
      select: DETAIL_SELECT,
    });
    if (!row) return null;
    const names = await storeNames(this.prisma, [row.storeId]);
    return {
      staffName: row.staffMember.name,
      detail: {
        ...toSummary(row, names(row.storeId)),
        isWithholdingApplied: row.isWithholdingApplied,
        items:
          row.status === 'SENT'
            ? row.payslipItems.map(({ payslipItemMaster, ...item }) => ({
                ...item,
                itemCode: payslipItemMaster.itemCode,
              }))
            : [],
      },
    };
  }
}

/**
 * 이 계정에 발송된(발송 완료, 또는 한 번이라도 보내 발송 이력이 있는 — 확정 취소로 검토 중인), 보존 기간 안의 명세서.
 * 만든 지 꼭 3년이 되는 순간부터 보이지 않는다.
 */
export function myPayslipWhere(
  accountId: number,
  now: Date,
): Prisma.PayslipWhereInput {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RETENTION_YEARS);
  return {
    staffMember: { accountId },
    createdAt: { gt: cutoff },
    OR: [{ status: 'SENT' }, { payslipLogs: { some: { logType: 'SEND' } } }],
  };
}

export function toSummary(
  r: SummaryRow,
  storeName: string,
): MyPayslipSummaryDto {
  const correcting = r.status !== 'SENT';
  return {
    payslipId: r.payslipId,
    periodStartDate: dateOnly(r.periodStartDate),
    periodEndDate: dateOnly(r.periodEndDate),
    employmentType: r.employmentType,
    status: r.status,
    correcting,
    grossPayAmount: correcting ? null : r.grossPayAmount,
    totalDeductionAmount: correcting ? null : r.totalDeductionAmount,
    netPayAmount: correcting ? null : r.netPayAmount,
    createdAt: r.createdAt,
    storeId: r.storeId,
    storeName,
    sentAt: r.payslipLogs.find((l) => l.logType === 'SEND')?.changedAt ?? null,
    logs: r.payslipLogs,
  };
}

/** 한국 시간 기준 YYYY-MM — 받은 달을 셀 때 쓴다. 서버가 UTC 로 돌아도 한국 0시~9시가 전달로 밀리지 않게. */
function kstMonth(at: Date): string {
  return kstToday(at).toISOString().slice(0, 7);
}
