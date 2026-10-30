import {
  checkProbationWage,
  MINIMUM_WAGE_INACTIVE,
  MINIMUM_WAGE_MISSING,
  MINIMUM_WAGE_NOT_NUMBER,
  probationWageFloor,
  probationWageOf,
  readMinimumWage,
} from './minimum-wage';

describe('최저임금 공통코드 MINIMUM_WAGE · HOURLY(WHALEERP-595)', () => {
  const read = (row: unknown) =>
    readMinimumWage({
      codeItem: { findUnique: jest.fn().mockResolvedValue(row) },
    } as never);
  const active = {
    label: '10320',
    status: 'ACTIVE',
    isDeleted: false,
    codeGroup: { status: 'ACTIVE', isDeleted: false },
  };

  it('플랫폼 원본 HOURLY 의 코드명을 시급으로 읽는다', async () => {
    const findUnique = jest.fn().mockResolvedValue(active);
    await expect(
      readMinimumWage({ codeItem: { findUnique } } as never),
    ).resolves.toEqual({ hourlyWage: 10320 });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        groupCode_itemCode_bpCode: {
          groupCode: 'MINIMUM_WAGE',
          itemCode: 'HOURLY',
          bpCode: 'BP000000',
        },
      },
      select: {
        label: true,
        status: true,
        isDeleted: true,
        codeGroup: { select: { status: true, isDeleted: true } },
      },
    });
  });

  // 검사가 조용히 꺼지지 않게 쓸 수 없는 까닭을 준다 — 저장이 그 문장으로 400(2026-10-30 김민식)
  it.each<[string, unknown, string]>([
    ['코드가 없음', null, MINIMUM_WAGE_MISSING],
    ['상세 삭제', { ...active, isDeleted: true }, MINIMUM_WAGE_MISSING],
    [
      '그룹 삭제',
      { ...active, codeGroup: { status: 'ACTIVE', isDeleted: true } },
      MINIMUM_WAGE_MISSING,
    ],
    [
      '상세 사용 중지',
      { ...active, status: 'INACTIVE' },
      MINIMUM_WAGE_INACTIVE,
    ],
    [
      '그룹 사용 중지',
      { ...active, codeGroup: { status: 'INACTIVE', isDeleted: false } },
      MINIMUM_WAGE_INACTIVE,
    ],
    ['코드명에 쉼표', { ...active, label: '10,320' }, MINIMUM_WAGE_NOT_NUMBER],
    ['코드명에 원', { ...active, label: '10320원' }, MINIMUM_WAGE_NOT_NUMBER],
    ['코드명 0', { ...active, label: '0' }, MINIMUM_WAGE_NOT_NUMBER],
    [
      '코드명이 int 범위 밖',
      { ...active, label: '2147483648' },
      MINIMUM_WAGE_NOT_NUMBER,
    ],
  ])('%s 이면 그 까닭', async (_, row, problem) => {
    await expect(read(row)).resolves.toEqual({ problem });
  });

  it('문장은 원인을 말하고 마침표로 끝난다', () => {
    for (const m of [
      MINIMUM_WAGE_MISSING,
      MINIMUM_WAGE_INACTIVE,
      MINIMUM_WAGE_NOT_NUMBER,
    ]) {
      expect(m).toMatch(/^최저임금 공통코드\(MINIMUM_WAGE · HOURLY\)/);
      expect(m.endsWith('.')).toBe(true);
    }
  });

  it('90% 하한은 원 미만 올림, 수습 중 시급은 원 미만 반올림 — 관리자 웹과 같다', () => {
    expect(probationWageFloor(10320)).toBe(9288);
    expect(probationWageFloor(10031)).toBe(9028); // 9027.9 → 9028
    expect(probationWageOf(10319, 10)).toBe(9287); // 9287.1
    expect(probationWageOf(12345, 10)).toBe(11111); // 11110.5 → 11111
    expect(probationWageOf(10000, 0)).toBe(10000);
  });

  describe('checkProbationWage', () => {
    const probation = { probationMonths: 3, probationWageReductionRate: 10 };

    it('딱 90%면 통과, 1원 모자라면 400', () => {
      const minimum = { hourlyWage: 10320 };
      expect(() =>
        checkProbationWage({ ...probation, wageAmount: 10320 }, minimum),
      ).not.toThrow();
      expect(() =>
        checkProbationWage({ ...probation, wageAmount: 10319 }, minimum),
      ).toThrow('수습 중 시급은 최저임금의 90%(9,288원) 이상이어야 합니다.');
    });

    it('최저임금을 쓸 수 없으면 그 까닭으로 400', () => {
      expect(() =>
        checkProbationWage(
          { ...probation, wageAmount: 20000 },
          { problem: MINIMUM_WAGE_INACTIVE },
        ),
      ).toThrow(MINIMUM_WAGE_INACTIVE);
    });

    it('수습이나 시급이 없으면 보지 않는다 — 최저임금을 쓸 수 없어도', () => {
      const broken = { problem: MINIMUM_WAGE_MISSING };
      expect(() =>
        checkProbationWage({ wageAmount: 5000 }, broken),
      ).not.toThrow();
      expect(() => checkProbationWage(probation, broken)).not.toThrow();
    });
  });
});
