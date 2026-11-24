import { isShown, pickedStores } from './payslip-shared';

describe('pickedStores — 상단 점포 범위 유형(storeTypes)', () => {
  const manageable = [
    { storeId: 1, storeTypeCode: 'DIRECT', isHq: false },
    { storeId: 2, storeTypeCode: 'FRANCHISE', isHq: false },
    { storeId: 3, storeTypeCode: 'DIRECT', isHq: true },
  ];
  let prisma: { store: { findMany: jest.Mock } };

  beforeEach(() => {
    // 폐점 점포는 없다 — 넘긴 점포를 모두 운영 중으로 돌려준다
    prisma = {
      store: {
        findMany: jest.fn(
          ({ where }: { where: { storeId: { in: number[] } } }) =>
            Promise.resolve(where.storeId.in.map((storeId) => ({ storeId }))),
        ),
      },
    };
  });
  const pick = (storeTypes?: string[]) =>
    pickedStores(prisma as never, manageable, undefined, storeTypes);
  const ids = (rows: { storeId: number }[]) => rows.map((s) => s.storeId);

  it('HQ 는 본사 점포만', async () => {
    expect(ids(await pick(['HQ']))).toEqual([3]);
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { storeId: { in: [3] }, storeStatusCode: { not: 'CLOSED' } },
      select: { storeId: true },
    });
  });

  it('DIRECT 는 본사가 아닌 직영만 — 본사는 store_type_code 가 DIRECT 여도 빠진다', async () => {
    expect(ids(await pick(['DIRECT']))).toEqual([1]);
  });

  it('유형을 주지 않으면 전부(본사 포함), 폐점을 묻지 않는다', async () => {
    expect(ids(await pick())).toEqual([1, 2, 3]);
    expect(prisma.store.findMany).not.toHaveBeenCalled();
  });
});

describe('isShown — 3.3% 원천징수 · 4대보험 가입(WHALEERP-756)', () => {
  // 금액은 비어 있다(미입력) — 금액이 있는 미가입 줄은 아래 describe 에서 본다
  const line = (itemCategory: string, itemCode: string) => ({
    itemCategory: itemCategory as never,
    payslipItemMaster: { itemCode },
    isEntered: false,
    adjustedAmount: null,
    calculatedAmount: null,
  });
  const lines = [
    line('BASIC', 'NATIONAL_PENSION'),
    line('BASIC', 'HEALTH_INSURANCE'),
    line('BASIC', 'EMPLOYMENT_INSURANCE'),
    line('BASIC', 'LONG_TERM_CARE_INSURANCE'),
    line('BASIC', 'INCOME_TAX'),
    line('BASIC', 'LOCAL_INCOME_TAX'),
    line('WITHHOLDING', 'BUSINESS_INCOME_TAX'),
    line('WITHHOLDING', 'BUSINESS_LOCAL_INCOME_TAX'),
    line('ADDITIONAL', 'YEAR_END_SETTLEMENT'),
    line('EARNING', 'BASE_PAY'),
  ];
  const shown = (withholding: boolean, health: boolean, employment: boolean) =>
    lines
      .filter((l) =>
        isShown(l, withholding, {
          isHealthPensionInsured: health,
          isEmploymentInjuryInsured: employment,
        }),
      )
      .map((l) => l.payslipItemMaster.itemCode);

  it('둘 다 미가입 — 4대보험 줄이 없고 소득세 · 지방소득세만(지급 · 추가 공제는 그대로)', () => {
    expect(shown(false, false, false)).toEqual([
      'INCOME_TAX',
      'LOCAL_INCOME_TAX',
      'YEAR_END_SETTLEMENT',
      'BASE_PAY',
    ]);
  });

  it('둘 다 미가입 + 3.3% — 사업소득세 · 지방소득세(원천징수)만', () => {
    expect(shown(true, false, false)).toEqual([
      'BUSINESS_INCOME_TAX',
      'BUSINESS_LOCAL_INCOME_TAX',
      'YEAR_END_SETTLEMENT',
      'BASE_PAY',
    ]);
  });

  it('건강보험 · 국민연금만 — 국민연금 · 건강보험 · 장기요양보험, 고용보험 없음', () => {
    expect(shown(false, true, false)).toEqual([
      'NATIONAL_PENSION',
      'HEALTH_INSURANCE',
      'LONG_TERM_CARE_INSURANCE',
      'INCOME_TAX',
      'LOCAL_INCOME_TAX',
      'YEAR_END_SETTLEMENT',
      'BASE_PAY',
    ]);
  });

  it('고용보험 · 산재보험만 — 고용보험만', () => {
    expect(shown(false, false, true)).toEqual([
      'EMPLOYMENT_INSURANCE',
      'INCOME_TAX',
      'LOCAL_INCOME_TAX',
      'YEAR_END_SETTLEMENT',
      'BASE_PAY',
    ]);
  });

  it('둘 다 가입 + 3.3% — 4대보험 넷과 원천징수 둘(소득세 · 지방소득세는 빠진다)', () => {
    expect(shown(true, true, true)).toEqual([
      'NATIONAL_PENSION',
      'HEALTH_INSURANCE',
      'EMPLOYMENT_INSURANCE',
      'LONG_TERM_CARE_INSURANCE',
      'BUSINESS_INCOME_TAX',
      'BUSINESS_LOCAL_INCOME_TAX',
      'YEAR_END_SETTLEMENT',
      'BASE_PAY',
    ]);
  });
});

describe('isShown — 미가입 4대보험 줄도 0 아닌 금액이면 보인다(WHALEERP-756, 2026-11-24 사용자 결정)', () => {
  const NONE = {
    isHealthPensionInsured: false,
    isEmploymentInjuryInsured: false,
  };
  const pension = (over: object) => ({
    itemCategory: 'BASIC' as const,
    payslipItemMaster: { itemCode: 'NATIONAL_PENSION' },
    isEntered: true,
    adjustedAmount: null,
    calculatedAmount: null,
    ...over,
  });

  it('미가입 + 0 아닌 금액 → 보인다(예전에 채워 확정한 금액이 합계에만 남지 않게)', () => {
    expect(isShown(pension({ adjustedAmount: 45_000 }), false, NONE)).toBe(
      true,
    );
    const employment = {
      ...pension({ adjustedAmount: 9_000 }),
      payslipItemMaster: { itemCode: 'EMPLOYMENT_INSURANCE' },
    };
    expect(isShown(employment, false, NONE)).toBe(true);
  });

  it('미가입 + 0 원 → 숨는다', () => {
    expect(isShown(pension({ adjustedAmount: 0 }), false, NONE)).toBe(false);
  });

  it('미가입 + 미입력 → 숨는다(값이 남아 있어도 넣지 않은 줄이면 금액이 없다)', () => {
    expect(
      isShown(
        pension({ isEntered: false, adjustedAmount: 45_000 }),
        false,
        NONE,
      ),
    ).toBe(false);
  });

  it('소득세 · 원천징수 규칙은 금액과 관계없다', () => {
    const incomeTax = {
      ...pension({ adjustedAmount: 10_000 }),
      payslipItemMaster: { itemCode: 'INCOME_TAX' },
    };
    expect(isShown(incomeTax, true, NONE)).toBe(false);
  });
});
