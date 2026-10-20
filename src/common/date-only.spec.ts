import { dateOnly } from './date-only';

describe('dateOnly', () => {
  it('UTC 자정 Date 를 YYYY-MM-DD 로, null 은 null', () => {
    expect(dateOnly(new Date('2026-10-20T00:00:00.000Z'))).toBe('2026-10-20');
    expect(dateOnly(null)).toBeNull();
  });
});
