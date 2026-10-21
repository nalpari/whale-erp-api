import {
  END_TIME_PATTERN,
  START_TIME_PATTERN,
  breakFits,
  defaultsOf,
  kstTimeOf,
  toSpan,
  weekdayOf,
  workDateOf,
} from './work-schedule-rules';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

describe('work-schedule-rules', () => {
  it('근무일 + 한국 시각을 순간으로 바꾼다', () => {
    expect(toSpan(d('2026-10-21'), '09:00', '18:00')).toEqual({
      startAt: new Date('2026-10-21T00:00:00.000Z'),
      endAt: new Date('2026-10-21T09:00:00.000Z'),
    });
  });

  it('종료가 시작보다 이르면 다음 날이다(자정 넘김)', () => {
    const span = toSpan(d('2026-10-21'), '22:00', '06:00');
    expect(span).toEqual({
      startAt: new Date('2026-10-21T13:00:00.000Z'),
      endAt: new Date('2026-10-21T21:00:00.000Z'),
    });
    // 근무일은 시작한 날
    expect(workDateOf(span!.startAt)).toEqual(d('2026-10-21'));
  });

  it('24:00 은 그날 자정, 00:00 시작도 받는다', () => {
    expect(toSpan(d('2026-10-21'), '18:00', '24:00')?.endAt).toEqual(
      new Date('2026-10-21T15:00:00.000Z'),
    );
    expect(toSpan(d('2026-10-21'), '00:00', '08:00')?.startAt).toEqual(
      new Date('2026-10-20T15:00:00.000Z'),
    );
    expect(workDateOf(new Date('2026-10-20T15:00:00.000Z'))).toEqual(
      d('2026-10-21'),
    );
  });

  it('시작 · 종료는 30분 단위만', () => {
    expect(START_TIME_PATTERN.test('09:30')).toBe(true);
    expect(START_TIME_PATTERN.test('09:15')).toBe(false);
    expect(START_TIME_PATTERN.test('24:00')).toBe(false);
    expect(END_TIME_PATTERN.test('24:00')).toBe(true);
    expect(END_TIME_PATTERN.test('23:45')).toBe(false);
  });

  it('24시간짜리는 받지 않는다', () => {
    expect(toSpan(d('2026-10-21'), '09:00', '09:00')).toBeNull();
    expect(toSpan(d('2026-10-21'), '00:00', '24:00')).toBeNull();
  });

  it('휴게는 근무 길이보다 짧아야 한다', () => {
    const span = toSpan(d('2026-10-21'), '09:00', '10:00')!;
    expect(breakFits(span, 59)).toBe(true);
    expect(breakFits(span, 60)).toBe(false);
  });

  it('요일 · 한국 시각 표시', () => {
    expect(weekdayOf(d('2026-10-21'))).toBe('WED');
    expect(weekdayOf(d('2026-10-25'))).toBe('SUN');
    expect(kstTimeOf(new Date('2026-10-21T15:00:00.000Z'))).toBe('00:00');
  });

  it('계약 휴게 시작 · 종료는 길이로 바꾼다', () => {
    expect(
      defaultsOf({
        startTime: t('09:00'),
        endTime: t('18:00'),
        breakStartTime: t('12:00'),
        breakEndTime: t('13:30'),
      }),
    ).toEqual({ startTime: '09:00', endTime: '18:00', breakMinutes: 90 });
    expect(
      defaultsOf({
        startTime: t('09:00'),
        endTime: t('13:00'),
        breakStartTime: null,
        breakEndTime: null,
      }).breakMinutes,
    ).toBe(0);
  });
});
