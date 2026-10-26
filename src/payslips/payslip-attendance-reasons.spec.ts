import {
  effectiveEnd,
  afterContractEndDays,
  afterEndDetail,
  ContractSpan,
  missingDays,
  missingDetail,
} from './payslip-attendance-reasons';

// 2026-09 — 9/1 화요일. 계약은 월 · 수 · 금.
const MWF: ContractSpan = {
  start: '2026-01-01',
  end: null,
  workDays: ['MON', 'WED', 'FRI'],
};

describe('출퇴근 검토 대기 사유 (WHALEERP-229)', () => {
  it('효력 끝 — 체결 뒤 종료된 계약은 종료일과 종료 처리한 날 가운데 이른 쪽, 종료일이 없어도 처리한 날까지', () => {
    const closed = [{ changedAt: new Date('2026-10-15T03:00:00Z') }];
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(
      effectiveEnd({
        status: 'ENDED',
        endDate: null,
        contractStatusHistories: closed,
      }),
    ).toBe('2026-10-15');
    expect(
      effectiveEnd({
        status: 'ENDED',
        endDate: d('2026-12-31'),
        contractStatusHistories: closed,
      }),
    ).toBe('2026-10-15');
    expect(
      effectiveEnd({
        status: 'ENDED',
        endDate: d('2026-10-10'),
        contractStatusHistories: closed,
      }),
    ).toBe('2026-10-10');
    expect(
      effectiveEnd({
        status: 'SIGNED',
        endDate: null,
        contractStatusHistories: [],
      }),
    ).toBeNull();
  });

  describe('missingDays', () => {
    const base = {
      periodStart: '2026-09-01',
      until: '2026-09-11',
      contracts: [MWF],
      retiredDate: null,
    };

    it('계약 근무 요일에 출근이 없는 날과 퇴근이 없는 날 — 날짜 내림차순', () => {
      const checkedIn = new Map([
        ['2026-09-02', true],
        ['2026-09-04', false],
        ['2026-09-07', true],
        ['2026-09-11', true],
      ]);
      expect(missingDays({ ...base, checkedIn })).toEqual([
        { date: '2026-09-09', kind: 'NONE' },
        { date: '2026-09-04', kind: 'NO_CHECK_OUT' },
      ]);
    });

    it('계약하지 않은 요일에 출근하고 퇴근이 없으면 퇴근 미등록이다 — 근무 요일이 아닌 빈 날은 누락이 아니다', () => {
      const checkedIn = new Map([
        ['2026-09-02', true],
        ['2026-09-04', true],
        ['2026-09-05', false],
        ['2026-09-07', true],
        ['2026-09-09', true],
        ['2026-09-11', true],
      ]);
      expect(missingDays({ ...base, checkedIn })).toEqual([
        { date: '2026-09-05', kind: 'NO_CHECK_OUT' },
      ]);
    });

    it('계약 기간 밖 · 퇴직일 뒤 · 마지막 날 뒤는 보지 않는다', () => {
      expect(
        missingDays({
          ...base,
          contracts: [{ ...MWF, start: '2026-09-05', end: '2026-09-30' }],
          retiredDate: '2026-09-08',
          checkedIn: new Map(),
        }),
      ).toEqual([{ date: '2026-09-07', kind: 'NONE' }]);
    });

    it('상세 — 「N일 누락 — 09-05 퇴근 미등록, 08-22 출근·퇴근 모두 없음」, 10일 넘으면 「외 N일」', () => {
      expect(
        missingDetail([
          { date: '2026-09-05', kind: 'NO_CHECK_OUT' },
          { date: '2026-08-22', kind: 'NONE' },
        ]),
      ).toBe(
        '출퇴근 기록이 2일 누락되었습니다 — 09-05 퇴근 미등록, 08-22 출근·퇴근 모두 없음',
      );
      const many = Array.from({ length: 12 }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        kind: 'NONE' as const,
      }));
      expect(missingDetail(many)).toMatch(/12일 누락.* 외 2일$/);
    });
  });

  describe('afterContractEndDays', () => {
    const ended: ContractSpan = { ...MWF, end: '2026-09-20' };

    it('가장 늦은 종료일 뒤에 출근한 날', () => {
      const r = afterContractEndDays(
        [{ ...MWF, end: '2026-09-10' }, ended],
        ['2026-09-23', '2026-09-18', '2026-09-21'],
      );
      expect(r).toEqual({
        end: '2026-09-20',
        days: ['2026-09-21', '2026-09-23'],
      });
      expect(afterEndDetail(r!)).toBe(
        '근로계약 만료일(2026-09-20) 뒤 출퇴근 기록이 2일 있습니다 — 09-21, 09-23',
      );
    });

    it('무기한 계약이 있거나 종료일 뒤 기록이 없으면 null', () => {
      expect(afterContractEndDays([MWF, ended], ['2026-09-25'])).toBeNull();
      expect(afterContractEndDays([ended], ['2026-09-18'])).toBeNull();
    });
  });
});
