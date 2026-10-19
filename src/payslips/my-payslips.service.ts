import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

const DETAIL_SELECT = {
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
 * 만든 날부터 3년 안의 것만 준다 — 재직 상태는 보지 않아 퇴직한 뒤에도 보인다(PAY-4). 발송 뒤 확정을 취소해 다시
 * 검토 중인 명세서는 다시 보낼 때까지 빠진다 — 이전 발송 값을 남기는 칸이 없어 고치는 중인 값을 보이게 된다.
 */
@Injectable()
export class MyPayslipsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    accountId: number,
    now: Date = new Date(),
  ): Promise<MyPayslipListResponseDto> {
    const rows = await this.prisma.payslip.findMany({
      where: mine(accountId, now),
      orderBy: [{ periodStartDate: 'desc' }, { payslipId: 'desc' }],
      select: SUMMARY_SELECT,
    });
    if (rows.length === 0) return { items: [] };
    const names = await storeNames(
      this.prisma,
      rows.map((r) => r.storeId),
    );
    return { items: rows.map((r) => toSummary(r, names(r.storeId))) };
  }

  /** 한 장. 없거나 남의 것 · 발송 전 · 보존 기간이 지난 것이면 null(컨트롤러가 404). */
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
      where: { payslipId, ...mine(accountId, now) },
      select: DETAIL_SELECT,
    });
    if (!row) return null;
    const names = await storeNames(this.prisma, [row.storeId]);
    return {
      staffName: row.staffMember.name,
      detail: {
        ...toSummary(row, names(row.storeId)),
        isWithholdingApplied: row.isWithholdingApplied,
        items: row.payslipItems.map(({ payslipItemMaster, ...item }) => ({
          ...item,
          itemCode: payslipItemMaster.itemCode,
        })),
      },
    };
  }
}

/** 이 계정에 발송된, 보존 기간 안의 명세서. 만든 지 꼭 3년이 되는 순간부터 보이지 않는다. */
function mine(accountId: number, now: Date): Prisma.PayslipWhereInput {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RETENTION_YEARS);
  return {
    status: 'SENT',
    staffMember: { accountId },
    createdAt: { gt: cutoff },
  };
}

function toSummary(r: SummaryRow, storeName: string): MyPayslipSummaryDto {
  return {
    payslipId: r.payslipId,
    periodStartDate: dateOnly(r.periodStartDate),
    periodEndDate: dateOnly(r.periodEndDate),
    employmentType: r.employmentType,
    status: r.status,
    grossPayAmount: r.grossPayAmount,
    totalDeductionAmount: r.totalDeductionAmount,
    netPayAmount: r.netPayAmount,
    createdAt: r.createdAt,
    storeName,
    logs: r.payslipLogs,
  };
}
