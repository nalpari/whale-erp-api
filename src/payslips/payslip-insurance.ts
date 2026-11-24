import type { Prisma, PrismaClient } from '@prisma/client';
import { validContractWhere } from './payslip-attendance-reasons';
import { dateOnly, type PayslipInsurance } from './payslip-shared';

// 명세서의 4대보험 가입 여부(WHALEERP-756, 2026-11-20 김지영). 근로계약서의 두 체크(건강보험 · 국민연금, 고용보험 · 산재보험)로
// 공제 줄을 보이고 감춘다 — 금액은 지금처럼 관리자가 넣고 다시 계산하지 않는다. 어느 계약을 보는지는 「기간 중 계약 변경」 사유를 세는
// 계약과 같다: 그 직원 레코드(점포마다 따로다)의, 급여 기간에 효력이 있던 체결 완료 · 체결 뒤 종료 계약(`validContractWhere`).
// 그중 하나라도 체크했으면 가입이다 — 달 중간에 가입하면 그 보험 줄이 보이고, 계약이 둘이라 「기간 중 계약 변경」도 붙는다.

type Db = Pick<PrismaClient | Prisma.TransactionClient, 'contract'>;

/** 명세서 하나를 가리키는 칸 — 직원 레코드와 급여 기간 */
export interface PayslipPeriod {
  staffMemberId: number;
  periodStartDate: Date;
  periodEndDate: Date;
}

const INSURANCE_SELECT = {
  staffMemberId: true,
  isHealthPensionInsured: true,
  isEmploymentInjuryInsured: true,
} satisfies Prisma.ContractSelect;

/** 계약들의 가입 여부 — 하나라도 체크했으면 true. 칸이 null 이면(nullable, 기본 false) 체크하지 않은 것이다 */
export const insuranceOf = (
  contracts: readonly {
    isHealthPensionInsured: boolean | null;
    isEmploymentInjuryInsured: boolean | null;
  }[],
): PayslipInsurance => ({
  isHealthPensionInsured: contracts.some(
    (c) => c.isHealthPensionInsured === true,
  ),
  isEmploymentInjuryInsured: contracts.some(
    (c) => c.isEmploymentInjuryInsured === true,
  ),
});

const periodKey = (p: PayslipPeriod) =>
  `${dateOnly(p.periodStartDate)}~${dateOnly(p.periodEndDate)}`;

/**
 * 여러 명세서의 가입 여부. 급여 기간마다 계약을 한 번 읽는다 — 명세서는 늘 그 달 1일 ~ 말일이라 목록 한 쪽이면 한 번이다(목록이
 * 줄마다 읽지 않게).
 */
export async function payslipInsuranceMany(
  db: Db,
  payslips: readonly PayslipPeriod[],
): Promise<(p: PayslipPeriod) => PayslipInsurance> {
  const groups = new Map<
    string,
    { start: Date; end: Date; staff: Set<number> }
  >();
  for (const p of payslips) {
    const key = periodKey(p);
    const group = groups.get(key) ?? {
      start: p.periodStartDate,
      end: p.periodEndDate,
      staff: new Set<number>(),
    };
    group.staff.add(p.staffMemberId);
    groups.set(key, group);
  }
  const found = new Map<
    string,
    Prisma.ContractGetPayload<{ select: typeof INSURANCE_SELECT }>[]
  >();
  // 차례로 읽는다 — 트랜잭션 안에서도 부르기 때문이다(한 연결에서 줄을 선다)
  for (const [key, g] of groups) {
    const rows = await db.contract.findMany({
      where: {
        staffMemberId: { in: [...g.staff] },
        ...validContractWhere(g.start, g.end),
      },
      select: INSURANCE_SELECT,
    });
    for (const r of rows) {
      const at = `${key}|${r.staffMemberId}`;
      found.set(at, [...(found.get(at) ?? []), r]);
    }
  }
  return (p) =>
    insuranceOf(found.get(`${periodKey(p)}|${p.staffMemberId}`) ?? []);
}

/** 명세서 하나의 가입 여부(`payslipInsuranceMany`) */
export async function payslipInsurance(
  db: Db,
  p: PayslipPeriod,
): Promise<PayslipInsurance> {
  return (await payslipInsuranceMany(db, [p]))(p);
}

/**
 * 그 가입 칸을 체크한, 급여 기간에 효력이 있던 계약이 있는 명세서 — 목록의 공제 미입력 검토 대기(where)용. where 에서는 명세서 행의
 * 기간을 쓸 수 없어 기간을 받는다 — 목록은 한 달의 명세서만 보고, 명세서 기간은 늘 그 달 1일 ~ 말일이라(payslip-draft
 * payPeriod) 그 달 범위가 곧 명세서 기간이다. 그 전제가 깨지면(달 중간 기간) 이 조각도 고쳐야 한다. 계약은 직원 레코드의 관계(staffMember.contracts)로 찾는다.
 */
export const insuredWhere = (
  field: keyof PayslipInsurance,
  periodStart: Date,
  periodEnd: Date,
): Prisma.PayslipWhereInput => ({
  staffMember: {
    contracts: {
      some: { [field]: true, ...validContractWhere(periodStart, periodEnd) },
    },
  },
});
