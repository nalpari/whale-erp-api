import { InternalServerErrorException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** 날짜만 있는 값(@db.Date — Prisma 는 UTC 자정 Date)을 YYYY-MM-DD 로. */
export const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

/** YYYY-MM 의 첫날부터 다음 달 첫날 전까지(날짜 칸 비교용). */
export function monthRange(month: string): { gte: Date; lt: Date } {
  const [year, m] = month.split('-').map(Number);
  return {
    gte: new Date(Date.UTC(year, m - 1, 1)),
    lt: new Date(Date.UTC(year, m, 1)),
  };
}

/** 기본급 급여 항목 코드(payslip_item_masters.item_code) */
export const BASE_PAY_ITEM_CODE = 'BASE_PAY';

/**
 * 줄의 금액. 넣지 않았으면 null — 0 과 다르다(공제 미입력). 화면의 itemAmount 와 같다. 명세서 수정(지급 · 공제 총액)과
 * 직원 상세 급여명세서 요약의 기본급이 같은 식을 쓴다.
 */
export const amountOf = (l: {
  isEntered: boolean;
  adjustedAmount: number | null;
  calculatedAmount: number | null;
}) => (l.isEntered ? (l.adjustedAmount ?? l.calculatedAmount ?? 0) : null);

/** 명세서 항목 순서 — 급여 항목 표의 순서, 같으면 줄 ID. */
export const ITEM_ORDER = [
  { payslipItemMaster: { sortOrder: 'asc' } },
  { payslipItemId: 'asc' },
] satisfies Prisma.PayslipItemOrderByWithRelationInput[];

/**
 * 점포 ID → 이름. 점포는 다른 팀 표라 Prisma 관계 없이 따로 읽는다. 명세서의 점포는 외래키로 묶여 있어, 못 찾으면
 * 데이터가 깨진 것이라 빈 칸으로 내보내지 않고 500 이다.
 */
export async function storeNames(
  prisma: Pick<PrismaService, 'store'>,
  storeIds: number[],
): Promise<(storeId: number) => string> {
  const rows = await prisma.store.findMany({
    where: { storeId: { in: [...new Set(storeIds)] } },
    select: { storeId: true, name: true },
  });
  const byId = new Map(rows.map((s) => [s.storeId, s.name]));
  return (storeId) => {
    const name = byId.get(storeId);
    if (name === undefined)
      throw new InternalServerErrorException(
        `점포 ${storeId} 를 찾을 수 없습니다`,
      );
    return name;
  };
}
