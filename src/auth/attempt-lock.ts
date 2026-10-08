/** 연속으로 틀릴 수 있는 횟수. 이 횟수에 닿으면 잠근다. */
export const MAX_FAILED_ATTEMPTS = 5;

/**
 * 잠금 시간. 단계 없이 5분으로 고정이다. 5분마다 5회라는 속도는 단계를 둬도
 * 두 번째 잠금부터 같아서, 단계를 두면 상태만 늘고 얻는 것이 없다.
 */
export const ATTEMPT_LOCK_MS = 5 * 60 * 1000;

export interface AttemptState {
  failedCount: number;
  /** 잠금이 풀리는 시각. 잠겨 있지 않으면 null. */
  lockExpiresAt: Date | null;
}

/** 처음 상태. 비밀번호가 새로 정해졌을 때도 이 상태로 되돌린다. */
export const CLEARED_ATTEMPT_STATE: AttemptState = {
  failedCount: 0,
  lockExpiresAt: null,
};

/** 해제 시각과 같은 순간은 풀린 것이다. 경계를 잠금으로 두면 5분이 늘어난다. */
export function isLocked(state: AttemptState, now: Date): boolean {
  return state.lockExpiresAt !== null && state.lockExpiresAt > now;
}

/**
 * 틀린 시도를 한 번 센 새 상태를 돌려준다. 받은 상태는 바꾸지 않는다.
 *
 * - 잠겨 있는 동안의 실패는 세지 않고 해제 시각도 늘리지 않는다. 늘리면
 *   잠긴 계정에 시도를 계속 보내 남의 잠금을 끝없이 미룰 수 있다.
 * - 잠금이 풀린 뒤의 첫 실패는 0 에서 다시 센다.
 */
export function registerFailure(state: AttemptState, now: Date): AttemptState {
  if (isLocked(state, now)) return state;

  const previous = state.lockExpiresAt === null ? state.failedCount : 0;
  const failedCount = previous + 1;
  return {
    failedCount,
    lockExpiresAt:
      failedCount >= MAX_FAILED_ATTEMPTS
        ? new Date(now.getTime() + ATTEMPT_LOCK_MS)
        : null,
  };
}
