// contract-duplicates 를 먼저 읽는다 — 순환 import 가 생기면 LIVE_RENEWAL 이 조건 없음({ status: {} })으로 굳는다(api #158 재리뷰)
import { IN_PROGRESS } from './contract-duplicates';
import { LIVE_RENEWAL, SIGNED_ONCE } from './signed-contract';

describe('LIVE_RENEWAL', () => {
  it('contract-duplicates 를 먼저 읽어도 진행 중 상태와 체결을 거친 계약을 본다', () => {
    expect(IN_PROGRESS).toEqual([
      'DRAFT',
      'PENDING_SEND',
      'PENDING_SIGNATURE',
      'CORRECTION_REQUESTED',
    ]);
    expect(LIVE_RENEWAL).toEqual({
      OR: [{ status: { in: IN_PROGRESS } }, SIGNED_ONCE],
    });
  });
});
