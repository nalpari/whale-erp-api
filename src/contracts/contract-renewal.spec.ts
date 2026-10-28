import { renewalDateOf } from './contract-renewal';

describe('renewalDateOf (갱신 예정일)', () => {
  // 한국 시간 2026-10-26
  const now = new Date('2026-10-26T03:00:00Z');
  const d = (s: string) => new Date(`${s}T00:00:00Z`);

  it('체결 완료이고 종료일이 오늘 이후면 종료일 30일 전 — 30일 안이면 이미 지난 날짜', () => {
    expect(
      renewalDateOf({ status: 'SIGNED', endDate: d('2026-12-31') }, now),
    ).toEqual(d('2026-12-01'));
    expect(
      renewalDateOf({ status: 'SIGNED', endDate: d('2026-10-26') }, now),
    ).toEqual(d('2026-09-26'));
  });

  it('종료일이 지났거나 없거나 체결 완료가 아니면 null', () => {
    expect(
      renewalDateOf({ status: 'SIGNED', endDate: d('2026-10-25') }, now),
    ).toBeNull();
    expect(renewalDateOf({ status: 'SIGNED', endDate: null }, now)).toBeNull();
    expect(
      renewalDateOf(
        { status: 'PENDING_SIGNATURE', endDate: d('2026-12-31') },
        now,
      ),
    ).toBeNull();
  });
});
