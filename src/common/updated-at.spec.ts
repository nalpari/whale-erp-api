import { isSameMillisecond, sameMillisecond } from './updated-at';

describe('sameMillisecond', () => {
  it('받은 ms 부터 다음 ms 앞까지의 범위다', () => {
    expect(sameMillisecond('2026-10-15T01:02:03.456Z')).toEqual({
      gte: new Date('2026-10-15T01:02:03.456Z'),
      lt: new Date('2026-10-15T01:02:03.457Z'),
    });
  });
});

describe('isSameMillisecond', () => {
  const iso = '2026-10-15T01:02:03.456Z';

  // JS Date 는 ms 까지라 µs 를 담지 못한다. 칸의 µs 는 Prisma 가 읽을 때 ms 로 잘라 주므로, 여기서는 같은 ms 만 본다.
  it('같은 ms 면 true', () => {
    expect(isSameMillisecond(new Date(iso), iso)).toBe(true);
  });

  it('다음 ms · 앞 ms 는 false', () => {
    const at = new Date(iso).getTime();
    expect(isSameMillisecond(new Date(at + 1), iso)).toBe(false);
    expect(isSameMillisecond(new Date(at - 1), iso)).toBe(false);
  });

  it('시간대 표기가 달라도 같은 순간이면 true', () => {
    expect(
      isSameMillisecond(new Date(iso), '2026-10-15T10:02:03.456+09:00'),
    ).toBe(true);
  });
});
