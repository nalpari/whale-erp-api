import {
  addDay,
  calculatePay,
  ContractTerms,
  PayInput,
  weekStats,
} from './pay-calculation';

// 2026-10 — 10/1 은 목요일. 10월에 걸친 주: 9/28 · 10/5 · 10/12 · 10/19 · 10/26 주. 9/28 주는 9월 몫(9/28 ~ 30)만으로, 10/26 주는
// 10월 몫(10/26 ~ 31)만으로 주휴 조건을 채우면 그 달이 맡는다.
const PERIOD = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };

/** from ~ to 에서 요일(0 일 ~ 6 토)이 맞는 날마다 minutes */
function days(from: string, to: string, weekdays: number[], minutes: number) {
  const out: Record<string, number> = {};
  for (let d = from; d <= to; d = addDay(d, 1))
    if (weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()))
      out[d] = minutes;
  return out;
}

/** 계약 하나짜리 입력 — 계약 조건 키(시급 · 계약 요일 · 계약 기간 등)를 덮으면 그 계약에 들어간다 */
type Over = Partial<Omit<PayInput, 'contracts'>> &
  Partial<Omit<ContractTerms, 'start' | 'end'>> & {
    contractStart?: string;
    contractEnd?: string | null;
    contracts?: ContractTerms[];
  };
function input(
  terms: ContractTerms,
  rest: Omit<PayInput, 'contracts'>,
  over: Over,
): PayInput {
  const {
    hourlyWage = terms.hourlyWage,
    baseHours = terms.baseHours,
    contractDays = terms.contractDays,
    includedOvertimeMinutes = terms.includedOvertimeMinutes,
    contractStart = terms.start,
    contractEnd = terms.end,
    contracts,
    ...others
  } = over;
  return {
    ...rest,
    ...others,
    contracts: contracts ?? [
      {
        start: contractStart,
        end: contractEnd,
        hourlyWage,
        baseHours,
        contractDays,
        includedOvertimeMinutes,
      },
    ],
  };
}

const partTimer = (over: Over = {}): PayInput =>
  input(
    {
      start: '2026-01-01',
      end: null,
      hourlyWage: 10_000,
      baseHours: null,
      contractDays: { MON: 300, WED: 300, FRI: 300 },
      includedOvertimeMinutes: 0,
    },
    {
      employmentType: 'PART_TIME',
      hiredDate: null,
      retiredDate: null,
      ...PERIOD,
      worked: days('2026-09-28', '2026-10-31', [1, 3, 5], 300),
      isPremiumApplied: true,
    },
    over,
  );

const fullTimer = (over: Over = {}): PayInput =>
  input(
    {
      start: '2026-01-01',
      end: null,
      hourlyWage: 10_030,
      baseHours: 209,
      contractDays: { MON: 480, TUE: 480, WED: 480, THU: 480, FRI: 480 },
      includedOvertimeMinutes: 0,
    },
    {
      employmentType: 'FULL_TIME',
      hiredDate: null,
      retiredDate: null,
      ...PERIOD,
      worked: days('2026-09-28', '2026-10-31', [1, 2, 3, 4, 5], 480),
      isPremiumApplied: true,
    },
    over,
  );

describe('calculatePay', () => {
  describe('파트타이머', () => {
    it('기본급은 근무 시간 × 시급, 주휴는 이 달이 맡은 개근 주마다 1주 소정 ÷ 40 × 8 × 시급', () => {
      // 10월 월 · 수 · 금 13일 × 5시간 = 65시간. 9/28 주는 9월 몫(월 · 수 10시간)이 15시간에 못 미쳐 10월이 주 전체로 맡고,
      // 10/26 주는 10월 몫(월 · 수 · 금 15시간)으로 채워 10월이 맡는다 — 개근 주 5개 × (15/40 × 8 × 10,000 = 30,000)
      expect(calculatePay(partTimer())).toEqual({
        basePay: 650_000,
        weeklyHolidayPay: 150_000,
        overtimePay: 0,
        workedMinutes: 3_900,
        overtimeMinutes: 0,
        weeklyHolidayWeeks: 5,
      });
    });

    it('그 요일 소정근로시간을 넘긴 분은 연장 — 가산을 켜면 기본급에서 빼고 1.5배로 준다', () => {
      const input = partTimer();
      input.worked['2026-10-16'] = 420;
      const on = calculatePay(input);
      expect(on.overtimeMinutes).toBe(120);
      expect(on.basePay).toBe(650_000);
      expect(on.overtimePay).toBe(30_000);
    });

    it('가산을 끄면 연장수당을 가산 없이 1배로 준다(PAY-05)', () => {
      const input = partTimer({ isPremiumApplied: false });
      input.worked['2026-10-16'] = 420;
      const off = calculatePay(input);
      expect(off.overtimePay).toBe(20_000);
      expect(off.basePay).toBe(650_000);
    });

    it('계약하지 않은 요일의 근무는 전부 연장이다', () => {
      const input = partTimer();
      input.worked['2026-10-13'] = 180; // 화요일
      expect(calculatePay(input).overtimeMinutes).toBe(180);
    });

    it('소정근로일 하루라도 빠진 주는 주휴가 없고, 지각 · 조퇴나 퇴근 기록 없음(0 분)도 출근이다', () => {
      const input = partTimer();
      delete input.worked['2026-10-14'];
      input.worked['2026-10-21'] = 0;
      expect(calculatePay(input).weeklyHolidayWeeks).toBe(4);
    });

    it('주 전체가 계약 기간 안이어야 주휴를 센다', () => {
      expect(
        calculatePay(partTimer({ contractStart: '2026-10-01' }))
          .weeklyHolidayWeeks,
      ).toBe(4);
    });

    describe('달을 걸친 주(PAY-04, 2026-10-26)', () => {
      // 월 · 화 · 수 5시간 — 9/28 주는 9월 몫(9/28 ~ 30)만으로 15시간을 채운다
      const mtw = (over: Over = {}) =>
        partTimer({
          contractDays: { MON: 300, TUE: 300, WED: 300 },
          worked: days('2026-08-31', '2026-11-01', [1, 2, 3], 300),
          ...over,
        });

      it('앞 달 몫으로 주휴 조건을 채운 주는 앞 달이 맡는다', () => {
        // 9월: 8/31 주(9월 몫이 월요일뿐이라 9월이 주 전체로) · 9/7 · 9/14 · 9/21 · 9/28 주(9월 몫으로 채움)
        expect(
          calculatePay(
            mtw({ periodStart: '2026-09-01', periodEnd: '2026-09-30' }),
          ).weeklyHolidayWeeks,
        ).toBe(5);
        // 10월: 9/28 주는 9월이 맡아 빼고 10/5 · 10/12 · 10/19 · 10/26 주
        expect(calculatePay(mtw()).weeklyHolidayWeeks).toBe(4);
      });

      it('앞 달 몫으로 못 채운 주는 다음 달이 주 전체로 본다 — 앞 달 몫의 결근도 다음 달 주휴를 막는다', () => {
        const input = partTimer();
        delete input.worked['2026-09-30'];
        expect(calculatePay(input).weeklyHolidayWeeks).toBe(4);
      });
    });

    it('정직원이 아니면 월간 연장(포괄)을 빼지 않는다', () => {
      const input = partTimer({ includedOvertimeMinutes: 600 });
      input.worked['2026-10-16'] = 420;
      expect(calculatePay(input).overtimePay).toBe(30_000);
    });

    it('1주 소정근로시간이 15시간 미만이면 주휴가 없다', () => {
      const r = calculatePay(
        partTimer({ contractDays: { MON: 300, WED: 300, FRI: 270 } }),
      );
      expect(r.weeklyHolidayPay).toBe(0);
      expect(r.weeklyHolidayWeeks).toBe(0);
    });
  });

  describe('정직원', () => {
    it('기본급은 시급 × 월 기본시간, 주휴는 기본급에 들어 있어 0', () => {
      expect(calculatePay(fullTimer())).toMatchObject({
        basePay: 2_096_270,
        weeklyHolidayPay: 0,
        overtimePay: 0,
      });
    });

    it('연장은 하루 8시간 · 주 40시간을 넘긴 분 — 같은 시간은 한 번만', () => {
      const input = fullTimer();
      input.worked['2026-10-14'] = 600; // 하루 +2시간
      input.worked['2026-10-17'] = 480; // 토요일 — 주 48시간
      const r = calculatePay(input);
      expect(r.overtimeMinutes).toBe(600);
      expect(r.overtimePay).toBe(150_450);
    });

    it('달을 걸친 주의 주 40시간 — 앞 달이 맡은 주는 앞 달이 센 만큼을 빼고 다음 달이 센다', () => {
      // 9/28 주: 9월 몫(9/28 ~ 30, 24시간)으로 주휴 조건을 채워 9월이 맡았고 9월 몫은 40시간 아래. 10/3(토) 8시간을 더해
      // 주 48시간 — 넘친 8시간을 10월이 센다
      const input = fullTimer();
      input.worked['2026-10-03'] = 480;
      expect(calculatePay(input).overtimeMinutes).toBe(480);
    });

    it('가산을 끄면 연장수당을 1배로 준다(PAY-05)', () => {
      const input = fullTimer({ isPremiumApplied: false });
      input.worked['2026-10-14'] = 600;
      expect(calculatePay(input).overtimePay).toBe(20_060);
    });

    it('연장수당은 근로계약 월간 연장(포괄)을 넘긴 분만 준다(PAY-04)', () => {
      const input = fullTimer({ includedOvertimeMinutes: 300 });
      input.worked['2026-10-14'] = 600; // 하루 +2시간
      input.worked['2026-10-17'] = 480; // 주 +8시간 — 연장 10시간 가운데 5시간은 포괄
      const r = calculatePay(input);
      expect(r.overtimeMinutes).toBe(600);
      expect(r.overtimePay).toBe(75_225);
    });

    it('급여 기간 중간에 입사 · 퇴사하면 기본급을 역일로 일할한다(PAY-22)', () => {
      // 2,096,270 × 16/31 · × 15/31
      expect(calculatePay(fullTimer({ hiredDate: '2026-10-16' })).basePay).toBe(
        1_081_946,
      );
      expect(
        calculatePay(fullTimer({ retiredDate: '2026-10-15' })).basePay,
      ).toBe(1_014_324);
      expect(calculatePay(fullTimer({ hiredDate: '2026-09-01' })).basePay).toBe(
        2_096_270,
      );
    });

    it('월간 연장(포괄)도 기본급처럼 재직 역일로 일할한다 — 달 중간 퇴사면 포괄이 줄어 넘긴 분을 준다', () => {
      // 10/15 퇴사 · 포괄 600 분 → 600 × 15/31 분. 10/12 ~ 15 하루 +2시간씩 연장 480 분
      const input = fullTimer({
        includedOvertimeMinutes: 600,
        retiredDate: '2026-10-15',
      });
      for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'])
        input.worked[d] = 600;
      expect(calculatePay(input).overtimePay).toBe(
        Math.round(((480 - (600 * 15) / 31) / 60) * 10_030 * 1.5),
      );
    });

    it('월 기본시간이 없으면 기본급을 계산하지 않는다', () => {
      expect(calculatePay(fullTimer({ baseHours: null })).basePay).toBeNull();
    });
  });

  describe('기간 중 계약 변경 — 날마다 그날 효력이 있는 계약으로(2026-10-26)', () => {
    /** 늦게 시작한 것부터 — 10/15 까지 A, 10/16 부터 B */
    const terms = (
      over: Partial<ContractTerms>,
      base: ContractTerms,
    ): ContractTerms => ({ ...base, ...over });
    const PART: ContractTerms = {
      start: '2026-01-01',
      end: '2026-10-15',
      hourlyWage: 10_000,
      baseHours: null,
      contractDays: { MON: 300, WED: 300, FRI: 300 },
      includedOvertimeMinutes: 0,
    };

    it('파트타이머 시급이 달 중간에 바뀌면 기본급 · 주휴를 그날(그 주 마지막 날) 계약 시급으로', () => {
      const r = calculatePay(
        partTimer({
          contracts: [
            terms({ start: '2026-10-16', end: null, hourlyWage: 12_000 }, PART),
            PART,
          ],
        }),
      );
      // 기본급: 10/2 ~ 10/14 의 6일 × 5시간 × 10,000 + 10/16 ~ 10/30 의 7일 × 5시간 × 12,000
      expect(r.basePay).toBe(300_000 + 420_000);
      // 주휴: 9/28 · 10/5 주는 A(30,000), 10/12 주(일요일 10/18 이 B) · 10/19 · 10/26 주는 B(36,000)
      expect(r.weeklyHolidayWeeks).toBe(5);
      expect(r.weeklyHolidayPay).toBe(2 * 30_000 + 3 * 36_000);
    });

    it('고용형태가 다른 계약이 섞이면 기본급 · 주휴 · 연장을 계산하지 않는다(null — 관리자가 넣는다, PR #159 리뷰)', () => {
      const r = calculatePay(
        partTimer({
          contracts: [terms({ start: '2026-10-16', end: null }, PART), PART],
          isEmploymentMixed: true,
        }),
      );
      expect([r.basePay, r.weeklyHolidayPay, r.overtimePay]).toEqual([
        null,
        null,
        null,
      ]);
    });

    it('파트타이머 연장은 그날 계약의 소정근로시간 · 시급으로', () => {
      const input = partTimer({
        contracts: [
          terms(
            {
              start: '2026-10-16',
              end: null,
              hourlyWage: 12_000,
              contractDays: { MON: 360, WED: 360, FRI: 360 },
            },
            PART,
          ),
          PART,
        ],
      });
      input.worked['2026-10-14'] = 420; // A — 5시간 넘긴 2시간
      input.worked['2026-10-21'] = 420; // B — 6시간 넘긴 1시간
      const r = calculatePay(input);
      expect(r.overtimeMinutes).toBe(180);
      expect(r.overtimePay).toBe(2 * 10_000 * 1.5 + 12_000 * 1.5);
    });

    it('한 주가 두 계약에 걸치면 그 주 마지막 날 계약으로 주휴를 센다 — 개근은 그날 계약 요일로', () => {
      // A 는 월 · 수 10시간(주휴 없음), B 는 월 · 수 · 금 15시간. 10/12 주는 10/12 · 14(A) · 16(B) 개근이고 일요일이 B 라 센다
      const mw = terms({ contractDays: { MON: 300, WED: 300 } }, PART);
      const b = terms({ start: '2026-10-16', end: null }, PART);
      const worked = {
        ...days('2026-09-28', '2026-10-15', [1, 3], 300),
        ...days('2026-10-16', '2026-10-31', [1, 3, 5], 300),
      };
      const r = calculatePay(partTimer({ contracts: [b, mw], worked }));
      expect(r.weeklyHolidayWeeks).toBe(3); // 10/12 · 10/19 · 10/26 주
      // 거꾸로(A 15시간 → B 10시간)면 10/12 주는 마지막 날 계약 B 가 15시간에 못 미쳐 없다
      const r2 = calculatePay(
        partTimer({
          contracts: [terms({ start: '2026-10-16', end: null }, mw), PART],
          worked: {
            ...days('2026-09-28', '2026-10-15', [1, 3, 5], 300),
            ...days('2026-10-16', '2026-10-31', [1, 3], 300),
          },
        }),
      );
      expect(r2.weeklyHolidayWeeks).toBe(2); // 9/28 · 10/5 주
    });

    describe('정직원', () => {
      const A: ContractTerms = {
        start: '2026-01-01',
        end: '2026-10-15',
        hourlyWage: 10_030,
        baseHours: 209,
        contractDays: { MON: 480, TUE: 480, WED: 480, THU: 480, FRI: 480 },
        includedOvertimeMinutes: 0,
      };
      const B = terms(
        { start: '2026-10-16', end: null, hourlyWage: 11_000 },
        A,
      );

      it('기본급은 계약마다 그 월급 × 효력인 역일 ÷ 기간 역일 — 입사 · 퇴사 일할과 함께', () => {
        // 2,096,270 × 15/31 + 2,299,000 × 16/31
        expect(calculatePay(fullTimer({ contracts: [B, A] })).basePay).toBe(
          2_200_905,
        );
        // 10/10 입사 — A 는 10/10 ~ 15 의 6일만: 2,096,270 × 6/31 + 2,299,000 × 16/31
        expect(
          calculatePay(
            fullTimer({ contracts: [B, A], hiredDate: '2026-10-10' }),
          ).basePay,
        ).toBe(1_592_310);
      });

      it('연장수당은 계약마다 그 계약 월간 연장(포괄)을 효력인 역일로 나눈 만큼을 넘긴 분 × 그 시급', () => {
        const input = fullTimer({
          contracts: [B, terms({ includedOvertimeMinutes: 600 }, A)],
        });
        input.worked['2026-10-14'] = 600; // A +2시간 — 포괄 600 × 15/31 분 안
        input.worked['2026-10-21'] = 600; // B +2시간
        const r = calculatePay(input);
        expect(r.overtimeMinutes).toBe(240);
        expect(r.overtimePay).toBe(2 * 11_000 * 1.5);
      });
    });
  });

  it('1일에 재계약해도 달을 걸친 주는 앞 계약까지 보고 주휴를 판정한다 — 앞 계약이 없으면 그 주를 잃는다', () => {
    // 9/28 주: 9월 몫(월 · 수 10시간)이 15시간에 못 미쳐 10월이 주 전체로 맡는다. 9/28 ~ 30 은 앞 계약 A 기간
    const A = {
      start: '2025-10-01',
      end: '2026-09-30',
      hourlyWage: 10_000,
      baseHours: null,
      contractDays: { MON: 300, WED: 300, FRI: 300 },
      includedOvertimeMinutes: 0,
    } satisfies ContractTerms;
    const B = { ...A, start: '2026-10-01', end: null };
    expect(
      calculatePay(partTimer({ contracts: [B], leadingContracts: [A] }))
        .weeklyHolidayWeeks,
    ).toBe(5);
    expect(calculatePay(partTimer({ contracts: [B] })).weeklyHolidayWeeks).toBe(
      4,
    );
  });

  it('앞 계약은 기간 앞 날에만 쓴다 — 시급이 없어도 이 달을 막지 않고, 기간 안 공백일에 쓰이지 않는다', () => {
    const A = {
      start: '2025-10-01',
      end: '2026-09-30',
      hourlyWage: null,
      baseHours: null,
      contractDays: { MON: 300, WED: 300, FRI: 300 },
      includedOvertimeMinutes: 0,
    } satisfies ContractTerms;
    const B = { ...A, start: '2026-10-05', hourlyWage: 10_000 };
    const r = calculatePay(
      partTimer({ contracts: [B], leadingContracts: [A] }),
    );
    // 10/2(금) 근무도 B 시급 — 앞 계약 A 로 셈하지 않는다
    expect(r.basePay).toBe(650_000);
  });

  it('시급이 없으면 셋 다 계산하지 않는다', () => {
    expect(calculatePay(partTimer({ hourlyWage: null }))).toMatchObject({
      basePay: null,
      weeklyHolidayPay: null,
      overtimePay: null,
    });
  });

  describe('weekStats (근태 요약 한 주)', () => {
    const week = { periodStart: '2026-10-12', periodEnd: '2026-10-18' };

    it('근무 분 · 연장 분 · 주휴 대상 — 급여 계산과 같은 규칙', () => {
      const input = partTimer(week);
      input.worked['2026-10-16'] = 420;
      expect(weekStats(input)).toEqual({
        workedMinutes: 1_020,
        overtimeMinutes: 120,
        weeklyHoliday: true,
      });
    });

    it('정직원도 주휴 대상을 센다 — 계약 요일 하루를 빠지면 아니다', () => {
      const input = fullTimer(week);
      expect(weekStats(input).weeklyHoliday).toBe(true);
      delete input.worked['2026-10-14'];
      expect(weekStats(input).weeklyHoliday).toBe(false);
    });
  });
});
