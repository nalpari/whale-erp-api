import {
  ATTEMPT_LOCK_MS,
  CLEARED_ATTEMPT_STATE,
  isLocked,
  MAX_FAILED_ATTEMPTS,
  registerFailure,
} from './attempt-lock';

describe('attempt-lock', () => {
  const now = new Date('2026-10-07T03:00:00.000Z');
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  it('5회 틀리면 잠그고, 잠금은 5분 고정이다', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
    expect(ATTEMPT_LOCK_MS).toBe(5 * 60 * 1000);
  });

  describe('isLocked', () => {
    it('잠금 해제 시각이 없으면 잠겨 있지 않다', () => {
      expect(isLocked(CLEARED_ATTEMPT_STATE, now)).toBe(false);
    });

    it('해제 시각이 아직 오지 않았으면 잠겨 있다', () => {
      expect(isLocked({ failedCount: 5, lockExpiresAt: at(1) }, now)).toBe(
        true,
      );
    });

    it('해제 시각과 정확히 같은 순간은 풀린 것으로 본다', () => {
      expect(isLocked({ failedCount: 5, lockExpiresAt: at(0) }, now)).toBe(
        false,
      );
    });
  });

  describe('registerFailure', () => {
    it('실패를 한 번 세고 아직 잠그지 않는다', () => {
      expect(registerFailure(CLEARED_ATTEMPT_STATE, now)).toEqual({
        failedCount: 1,
        lockExpiresAt: null,
      });
    });

    it('4회째까지는 잠그지 않는다', () => {
      const state = registerFailure(
        { failedCount: 3, lockExpiresAt: null },
        now,
      );

      expect(state).toEqual({ failedCount: 4, lockExpiresAt: null });
    });

    it('5회째에 지금부터 5분 뒤까지 잠근다', () => {
      const state = registerFailure(
        { failedCount: 4, lockExpiresAt: null },
        now,
      );

      expect(state).toEqual({
        failedCount: 5,
        lockExpiresAt: at(ATTEMPT_LOCK_MS),
      });
    });

    it('잠겨 있는 동안의 실패는 세지 않고 잠금을 늘리지 않는다', () => {
      const locked = { failedCount: 5, lockExpiresAt: at(60_000) };

      expect(registerFailure(locked, now)).toEqual(locked);
    });

    it('잠금이 풀린 뒤 첫 실패는 0 에서 다시 센다', () => {
      const expired = { failedCount: 5, lockExpiresAt: at(-1) };

      expect(registerFailure(expired, now)).toEqual({
        failedCount: 1,
        lockExpiresAt: null,
      });
    });

    it('풀린 뒤에도 5회를 다시 채워야 잠근다 — 늘어나지 않고 5분 그대로다', () => {
      let state = { failedCount: 5, lockExpiresAt: at(-1) };
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1)
        state = registerFailure(state, now);

      expect(state).toEqual({
        failedCount: 5,
        lockExpiresAt: at(ATTEMPT_LOCK_MS),
      });
    });

    it('받은 상태를 바꾸지 않는다', () => {
      const state = { failedCount: 2, lockExpiresAt: null };

      registerFailure(state, now);

      expect(state).toEqual({ failedCount: 2, lockExpiresAt: null });
    });
  });

  describe('CLEARED_ATTEMPT_STATE', () => {
    it('실패 횟수 0, 잠금 없음이다', () => {
      expect(CLEARED_ATTEMPT_STATE).toEqual({
        failedCount: 0,
        lockExpiresAt: null,
      });
    });
  });
});
