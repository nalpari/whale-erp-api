import {
  minimumWageOn,
  parseMinimumWage,
  probationWageFloor,
  probationWageOf,
  readMinimumWages,
} from './minimum-wage';

describe('최저임금 공통코드(WHALEERP-595)', () => {
  it('상세코드 D+시행일 · 코드명 시급을 읽는다', () => {
    expect(parseMinimumWage('D20260101', '10320')).toEqual({
      effectiveDate: '2026-01-01',
      hourlyWage: 10320,
    });
  });

  it.each<[string, string]>([
    ['Y2026', '10320'], // 시행일 형식이 아님
    ['D20260230', '10320'], // 없는 날짜
    ['D2026010', '10320'],
    ['D20260101', '10,320'], // 코드명은 숫자만
    ['D20260101', '10320원'],
    ['D20260101', '0'],
    ['D20260101', '2147483648'], // int 범위 밖
  ])('%s = %s 는 형식이 틀려 null', (itemCode, label) => {
    expect(parseMinimumWage(itemCode, label)).toBeNull();
  });

  it('틀린 행은 빼고 경고를 남기며, 시행일 오름차순으로 준다', async () => {
    const warn = jest.fn();
    const prisma = {
      codeItem: {
        findMany: jest.fn().mockResolvedValue([
          { itemCode: 'D20270101', label: '11000' },
          { itemCode: 'D20260101', label: '10,320원' },
          { itemCode: 'D20250101', label: '10030' },
        ]),
      },
    };
    await expect(readMinimumWages(prisma as never, { warn })).resolves.toEqual([
      { effectiveDate: '2025-01-01', hourlyWage: 10030 },
      { effectiveDate: '2027-01-01', hourlyWage: 11000 },
    ]);
    expect(warn).toHaveBeenCalledWith(
      '최저임금 공통코드 형식이 틀려 뺍니다: D20260101 = 10,320원',
    );
  });

  it('그날 적용되는 값은 시행일이 그날 이전(그날 포함)인 것 중 가장 늦은 것', () => {
    const wages = [
      { effectiveDate: '2026-01-01', hourlyWage: 10320 },
      { effectiveDate: '2027-01-01', hourlyWage: 11000 },
    ];
    expect(minimumWageOn(wages, '2025-12-31')).toBeNull();
    expect(minimumWageOn(wages, '2026-01-01')?.hourlyWage).toBe(10320);
    expect(minimumWageOn(wages, '2026-12-31')?.hourlyWage).toBe(10320);
    expect(minimumWageOn(wages, '2027-01-01')?.hourlyWage).toBe(11000);
  });

  it('90% 하한은 원 미만 올림, 수습 중 시급은 원 미만 반올림 — 관리자 웹과 같다', () => {
    expect(probationWageFloor(10320)).toBe(9288);
    expect(probationWageFloor(10031)).toBe(9028); // 9027.9 → 9028
    expect(probationWageOf(10319, 10)).toBe(9287); // 9287.1
    expect(probationWageOf(12345, 10)).toBe(11111); // 11110.5 → 11111
    expect(probationWageOf(10000, 0)).toBe(10000);
  });
});
