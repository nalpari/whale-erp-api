import { attendanceDayStatus, type DayPunch } from './attendance-day-status';

const at = (iso: string): DayPunch => ({
  attendanceRecordId: 1,
  recordedAt: new Date(iso),
  reviewReason: null,
  entryMethod: 'SELF',
});
const nine = new Date('2026-10-23T00:00:00Z'); // 한국 09:00
const noon = new Date('2026-10-23T03:00:00Z');

describe('attendanceDayStatus', () => {
  it('근무스케줄도 기록도 없으면 휴무', () => {
    expect(attendanceDayStatus([], [], false, noon)).toBe('OFF');
  });

  it('기록 없이 근무스케줄만 — 시작이 지났으면 미출근, 아직이면 null', () => {
    expect(attendanceDayStatus([nine], [], false, noon)).toBe('ABSENT');
    expect(
      attendanceDayStatus([nine], [], false, new Date('2026-10-22T23:00:00Z')),
    ).toBeNull();
  });

  it('첫 출근이 첫 시작 분보다 늦으면 지각 — 같은 분 안은 정상', () => {
    const late = { checkIn: at('2026-10-23T00:01:00Z'), checkOut: null };
    const onTime = { checkIn: at('2026-10-23T00:00:40Z'), checkOut: null };
    expect(attendanceDayStatus([nine], [late], false, noon)).toBe('LATE');
    expect(attendanceDayStatus([nine], [onTime], false, noon)).toBe('NORMAL');
  });

  it('지난 날 퇴근 없는 출근은 퇴근 미등록, 오늘은 근무 중이라 그대로', () => {
    const open = { checkIn: at('2026-10-23T00:00:00Z'), checkOut: null };
    expect(attendanceDayStatus([nine], [open], true, noon)).toBe(
      'MISSING_CHECK_OUT',
    );
    expect(attendanceDayStatus([nine], [open], false, noon)).toBe('NORMAL');
  });

  it('출근 없는 퇴근은 출근 미등록이 먼저', () => {
    const orphan = { checkIn: null, checkOut: at('2026-10-23T09:00:00Z') };
    expect(attendanceDayStatus([nine], [orphan], true, noon)).toBe(
      'MISSING_CHECK_IN',
    );
  });

  it('근무스케줄 없는 날 출근은 정상', () => {
    const pair = {
      checkIn: at('2026-10-23T05:00:00Z'),
      checkOut: at('2026-10-23T09:00:00Z'),
    };
    expect(attendanceDayStatus([], [pair], true, noon)).toBe('NORMAL');
  });
});
