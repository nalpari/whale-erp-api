import { addDay, calculatePay, PayInput, weekStats } from './pay-calculation';

// 2026-10 — 10/1 은 목요일. 일요일이 10월인 주: 9/28 · 10/5 · 10/12 · 10/19 주(10/26 주는 일요일이 11/1 이라 11월).
const PERIOD = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };

/** from ~ to 에서 요일(0 일 ~ 6 토)이 맞는 날마다 minutes */
function days(from: string, to: string, weekdays: number[], minutes: number) {
  const out: Record<string, number> = {};
  for (let d = from; d <= to; d = addDay(d, 1))
    if (weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()))
      out[d] = minutes;
  return out;
}

const partTimer = (over: Partial<PayInput> = {}): PayInput => ({
  employmentType: 'PART_TIME',
  hourlyWage: 10_000,
  baseHours: null,
  contractDays: { MON: 300, WED: 300, FRI: 300 },
  contractStart: '2026-01-01',
  contractEnd: null,
  ...PERIOD,
  worked: days('2026-09-28', '2026-10-31', [1, 3, 5], 300),
  isPremiumApplied: true,
  ...over,
});

const fullTimer = (over: Partial<PayInput> = {}): PayInput => ({
  employmentType: 'FULL_TIME',
  hourlyWage: 10_030,
  baseHours: 209,
  contractDays: { MON: 480, TUE: 480, WED: 480, THU: 480, FRI: 480 },
  contractStart: '2026-01-01',
  contractEnd: null,
  ...PERIOD,
  worked: days('2026-09-28', '2026-10-31', [1, 2, 3, 4, 5], 480),
  isPremiumApplied: true,
  ...over,
});

describe('calculatePay', () => {
  describe('파트타이머', () => {
    it('기본급은 근무 시간 × 시급, 주휴는 일요일이 이 달인 개근 주마다 1주 소정 ÷ 40 × 8 × 시급', () => {
      // 10월 월 · 수 · 금 13일 × 5시간 = 65시간, 개근 주 4개 × (15/40 × 8 × 10,000 = 30,000)
      expect(calculatePay(partTimer())).toEqual({
        basePay: 650_000,
        weeklyHolidayPay: 120_000,
        overtimePay: 0,
        workedMinutes: 3_900,
        overtimeMinutes: 0,
        weeklyHolidayWeeks: 4,
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

    it('가산을 끄면 연장수당을 계산하지 않고 그 시간은 기본급에 남는다(PAY-05)', () => {
      const input = partTimer({ isPremiumApplied: false });
      input.worked['2026-10-16'] = 420;
      const off = calculatePay(input);
      expect(off.overtimePay).toBeNull();
      expect(off.basePay).toBe(670_000);
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
      expect(calculatePay(input).weeklyHolidayWeeks).toBe(3);
    });

    it('주 전체가 계약 기간 안이어야 주휴를 센다', () => {
      expect(
        calculatePay(partTimer({ contractStart: '2026-10-01' }))
          .weeklyHolidayWeeks,
      ).toBe(3);
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

    it('월 기본시간이 없으면 기본급을 계산하지 않는다', () => {
      expect(calculatePay(fullTimer({ baseHours: null })).basePay).toBeNull();
    });
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
