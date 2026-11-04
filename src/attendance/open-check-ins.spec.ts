import { editableStart } from './attendance-rules';
import { checkOutExpired, openCheckInsOf } from './open-check-ins';

describe('점포의 열린 출근 (WHALEERP-644 · 647 · 650 공용)', () => {
  it('짝 퇴근 없는 출근, 보정할 수 있는 3개월 안, 출근 시각순 — 직원 상태는 거르지 않는다', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await openCheckInsOf({ attendanceRecord: { findMany } } as never, [7, 8]);
    const arg = (
      findMany.mock.calls[0] as [{ where: unknown; orderBy: unknown }]
    )[0];
    expect(arg.where).toEqual({
      storeId: { in: [7, 8] },
      kind: 'CHECK_IN',
      attendanceRecordsAsCheckIn: { none: {} },
      recordedAt: { gte: editableStart() },
    });
    expect(arg.orderBy).toEqual([
      { recordedAt: 'asc' },
      { attendanceRecordId: 'asc' },
    ]);
  });

  it('앱 퇴근은 출근한 다음 날까지 — 그저께 출근부터 기한이 지났다(한국 날짜)', () => {
    // 한국 11/03 10:00
    const now = new Date('2026-11-03T01:00:00Z');
    expect(checkOutExpired(new Date('2026-11-03T00:00:00Z'), now)).toBe(false);
    // 한국 11/02 23:30 — 어제
    expect(checkOutExpired(new Date('2026-11-02T14:30:00Z'), now)).toBe(false);
    // 한국 11/01 23:59 — 그저께
    expect(checkOutExpired(new Date('2026-11-01T14:59:00Z'), now)).toBe(true);
  });
});
