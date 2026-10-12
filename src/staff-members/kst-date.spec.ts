import {
  addDays,
  addMonths,
  kstDayStart,
  kstToday,
  parseDateOnly,
} from './kst-date';

describe('kst-date', () => {
  describe('kstToday', () => {
    it('한국 시간의 오늘 날짜를 UTC 자정 Date 로 돌려준다 — DB 의 date 칸과 같은 모양', () => {
      // 한국 10/08 08:59 = UTC 10/07 23:59
      expect(kstToday(new Date('2026-10-07T23:59:00Z'))).toEqual(
        new Date('2026-10-08T00:00:00Z'),
      );
    });

    it('UTC 로는 같은 날이어도 한국 자정 전이면 전날이다', () => {
      // 한국 10/07 23:59 = UTC 10/07 14:59
      expect(kstToday(new Date('2026-10-07T14:59:00Z'))).toEqual(
        new Date('2026-10-07T00:00:00Z'),
      );
    });
  });

  it('kstDayStart 는 그 날짜의 한국 자정 순간이다', () => {
    expect(kstDayStart(new Date('2026-10-08T00:00:00Z'))).toEqual(
      new Date('2026-10-07T15:00:00Z'),
    );
  });

  it('addDays 는 날짜를 하루 단위로 옮긴다(월말을 넘어도)', () => {
    expect(addDays(new Date('2026-10-31T00:00:00Z'), 1)).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    );
  });

  describe('addMonths', () => {
    it('달을 옮긴다', () => {
      expect(addMonths(new Date('2026-10-08T00:00:00Z'), -3)).toEqual(
        new Date('2026-07-08T00:00:00Z'),
      );
    });

    it('옮긴 달에 그 날이 없으면 그 달 마지막 날이다 — 다음 달로 넘기지 않는다', () => {
      expect(addMonths(new Date('2026-05-31T00:00:00Z'), -3)).toEqual(
        new Date('2026-02-28T00:00:00Z'),
      );
    });
  });

  describe('parseDateOnly', () => {
    it('YYYY-MM-DD 를 UTC 자정 Date 로 읽는다', () => {
      expect(parseDateOnly('2026-02-28')).toEqual(
        new Date('2026-02-28T00:00:00Z'),
      );
    });

    it.each(['2026-02-30', '2026-13-01', '2026-1-1', '20261001', ''])(
      '없는 날짜나 다른 모양(%p)은 null',
      (raw) => {
        expect(parseDateOnly(raw)).toBeNull();
      },
    );
  });
});
