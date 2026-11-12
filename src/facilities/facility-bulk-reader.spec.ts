import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { BULK_BUSY, BULK_BUSY_CODE, WorkerSlots } from './facility-bulk-reader';

/** 503 본문 — front 가 앞단 게이트웨이의 503 과 가르도록 code 를 싣는다 */
const BUSY_BODY = {
  statusCode: HttpStatus.SERVICE_UNAVAILABLE,
  error: 'Service Unavailable',
  code: 'BULK_BUSY',
  message: BULK_BUSY,
};

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('거부되지 않았다');
}

// worker 자리 — 동시 수 · 대기열 길이 · 대기 시간에 상한이 있고, 넘으면 503(PR #276 3차 리뷰)
describe('WorkerSlots', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('code 값은 BULK_BUSY 다(다른 자원의 일괄 등록도 같은 값을 쓴다)', () => {
    expect(BULK_BUSY_CODE).toBe('BULK_BUSY');
  });

  it('자리가 있으면 바로 얻고, 없으면 줄을 섰다가 반납되면 차례로 얻는다', async () => {
    const slots = new WorkerSlots(1, 2, 30_000);
    await slots.acquire();
    const order: number[] = [];
    const a = slots.acquire().then(() => order.push(1));
    const b = slots.acquire().then(() => order.push(2));
    expect(slots.waitingCount).toBe(2);
    slots.release();
    await a;
    slots.release();
    await b;
    expect(order).toEqual([1, 2]);
    expect(slots.waitingCount).toBe(0);
  });

  it('대기열이 가득 차면 줄을 세우지 않고 바로 503(code BULK_BUSY)', async () => {
    const slots = new WorkerSlots(1, 1, 30_000);
    await slots.acquire();
    const waiting = slots.acquire();
    const error = await rejectionOf(slots.acquire());
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual(
      BUSY_BODY,
    );
    slots.release();
    await waiting;
  });

  it('대기 시간을 넘기면 503(code BULK_BUSY) 이고 대기열에서 빠진다(반납돼도 그 요청은 자리를 얻지 않는다)', async () => {
    const slots = new WorkerSlots(1, 2, 30_000);
    await slots.acquire();
    const late = rejectionOf(slots.acquire());
    jest.advanceTimersByTime(30_000);
    const error = await late;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual(
      BUSY_BODY,
    );
    expect(slots.waitingCount).toBe(0);
    slots.release();
    // 자리가 다시 비었다 — 새 요청은 바로 얻는다
    await slots.acquire();
    expect(slots.activeCount).toBe(1);
  });
});
