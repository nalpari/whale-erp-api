import {
  effectiveEnd,
  employmentMixed,
  reviewReasonsOf,
  attendanceReviewReasons,
  afterContractEndDays,
  afterEndDetail,
  ContractSpan,
  confirmableFrom,
  missingDays,
  flaggedDetail,
  missingDetail,
  NO_ATTENDANCE_DETAIL,
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

  it('고용형태가 섞이면 「기간 중 계약 변경」 문구가 직접 입력을 요구한다 — 맞게 계산된 것으로 읽히지 않게', () => {
    expect(
      employmentMixed([
        { employmentType: 'FULL_TIME' },
        { employmentType: 'PART_TIME' },
      ]),
    ).toBe(true);
    expect(
      employmentMixed([
        { employmentType: 'PART_TIME' },
        { employmentType: null },
        { employmentType: 'PART_TIME' },
      ]),
    ).toBe(false);
    expect(reviewReasonsOf([], [1, 2], true)).toEqual([
      expect.objectContaining({
        reviewReason: 'CONTRACT_CHANGED',
        detail: expect.stringContaining('직접 입력해 주세요') as unknown,
      }),
    ]);
    expect(reviewReasonsOf([], [1, 2])[0].detail).toContain(
      '나눠 계산했습니다',
    );
  });

  it('확인 필요 기록은 급여 계산과 같이 짝 퇴근을 출근한 날로 센다 — 월말 밤샘 퇴근의 사유가 다음 달로 넘어가지 않게 · 달을 걸친 첫 주의 앞 달 날(9/28 ~ 30)도 센다(운영 정책 v247 PAY-06)', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const db = {
      contract: { findMany: jest.fn().mockResolvedValue([]) },
      staffMember: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ retiredDate: null }),
      },
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([]), count },
    };
    await attendanceReviewReasons(
      db as never,
      {
        staffMemberId: 7,
        contractIds: [],
        periodStartDate: new Date('2026-10-01T00:00:00Z'),
        periodEndDate: new Date('2026-10-31T00:00:00Z'),
      },
      new Date('2026-11-05T00:00:00Z'),
    );
    // 출근 없는 퇴근은 급여 기간 안의 것만(`orphan`) — 그 달 출근 누락의 신호라 앞 달 날의 것은 앞 달 명세서가 알린다(api #206 리뷰)
    const where = (
      range: { gte: Date; lt: Date },
      orphan: { gte: Date; lt: Date } | null,
    ) => ({
      where: {
        staffMemberId: 7,
        reviewReason: { not: null },
        OR: [
          { kind: 'CHECK_IN', recordedAt: range },
          ...(orphan
            ? [
                {
                  kind: 'CHECK_OUT',
                  checkInAttendanceRecordId: null,
                  recordedAt: orphan,
                },
              ]
            : []),
          { kind: 'CHECK_OUT', checkInAttendanceRecord: { recordedAt: range } },
        ],
      },
    });
    // 10/1 은 목요일 — 그 주 월요일 9/28 부터 세고, 그중 앞 달 날(9/28 ~ 30) 것을 따로 센다
    const oct1 = new Date('2026-09-30T15:00:00Z');
    const nov1 = new Date('2026-10-31T15:00:00Z');
    const sep28 = new Date('2026-09-27T15:00:00Z');
    expect(count.mock.calls).toEqual([
      [where({ gte: sep28, lt: nov1 }, { gte: oct1, lt: nov1 })],
      [where({ gte: sep28, lt: oct1 }, null)],
    ]);
    const october = (now = new Date('2026-11-05T00:00:00Z')) =>
      attendanceReviewReasons(
        db as never,
        {
          staffMemberId: 7,
          contractIds: [],
          periodStartDate: new Date('2026-10-01T00:00:00Z'),
          periodEndDate: new Date('2026-10-31T00:00:00Z'),
        },
        now,
      );
    // 기간 안에만 있으면 「급여 기간에」
    count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    expect(await october()).toContainEqual({
      reviewReason: 'ATTENDANCE_NEEDS_REVIEW',
      detail: '급여 기간에 확인 필요 출퇴근 기록이 2건 있습니다',
    });
    // 앞 달 날에만 있어도 이 달 사유로 붙고, 문구가 그 날짜를 밝힌다
    count.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    expect(
      await attendanceReviewReasons(
        db as never,
        {
          staffMemberId: 7,
          contractIds: [],
          periodStartDate: new Date('2026-10-01T00:00:00Z'),
          periodEndDate: new Date('2026-10-31T00:00:00Z'),
        },
        new Date('2026-11-05T00:00:00Z'),
      ),
    ).toContainEqual({
      reviewReason: 'ATTENDANCE_NEEDS_REVIEW',
      detail:
        '급여 기간과 첫 주 앞 달 날(09-28 ~ 09-30)에 확인 필요 출퇴근 기록이 2건 있습니다',
    });
    // 6/1 은 월요일 — 앞 달 날이 없어 급여 기간만 한 번 센다
    count.mockClear();
    await attendanceReviewReasons(
      db as never,
      {
        staffMemberId: 7,
        contractIds: [],
        periodStartDate: new Date('2026-06-01T00:00:00Z'),
        periodEndDate: new Date('2026-06-30T00:00:00Z'),
      },
      new Date('2026-11-05T00:00:00Z'),
    );
    const june = {
      gte: new Date('2026-05-31T15:00:00Z'),
      lt: new Date('2026-06-30T15:00:00Z'),
    };
    expect(count.mock.calls).toEqual([[where(june, june)]]);
  });

  describe('confirmableFrom (확정할 수 있는 첫날, 운영 정책 PAY-06 v251)', () => {
    const contract = (endDate: string | null, closedAt?: string) => ({
      status: closedAt ? 'ENDED' : 'SIGNED',
      endDate: endDate ? new Date(`${endDate}T00:00:00Z`) : null,
      contractStatusHistories: closedAt
        ? [{ changedAt: new Date(closedAt) }]
        : [],
    });
    const count = jest.fn();
    beforeEach(() => count.mockReset().mockResolvedValue(0));
    const from = (
      contracts: object[],
      retiredDate: string | null = null,
      contractIds = [1],
    ) =>
      confirmableFrom(
        {
          contract: {
            findMany: jest.fn().mockResolvedValue(contracts),
            count,
          },
          staffMember: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({
              retiredDate: retiredDate
                ? new Date(`${retiredDate}T00:00:00Z`)
                : null,
            }),
          },
        } as never,
        {
          staffMemberId: 7,
          contractIds,
          periodEndDate: new Date('2026-10-31T00:00:00Z'),
        },
      );

    it('퇴직 · 계약 종료가 없으면 급여 기간 마지막 날 다음 날', async () => {
      expect(await from([contract(null)])).toBe('2026-11-01');
      expect(await from([contract('2026-12-31')])).toBe('2026-11-01');
      expect(await from([], null, [])).toBe('2026-11-01');
    });

    it('기간 중 퇴직하면 퇴직일 다음 날 — 14일 청산 기한(근로기준법 제36조) 안에 확정할 수 있게', async () => {
      expect(await from([contract(null)], '2026-10-15')).toBe('2026-10-16');
      // 기간 전에 퇴직했으면 곧바로, 기간 뒤 퇴직(예정)이면 급여 기간 마지막 날 다음 날
      expect(await from([contract(null)], '2026-09-20')).toBe('2026-09-21');
      expect(await from([contract(null)], '2026-11-10')).toBe('2026-11-01');
    });

    it('기간 중 계약이 끝나면 가장 늦은 계약 종료일 다음 날 — 종료 처리한 날이 이르면 그날, 무기한 계약이 있으면 보지 않는다', async () => {
      expect(await from([contract('2026-10-10'), contract('2026-10-20')])).toBe(
        '2026-10-21',
      );
      // 종료일 12/31 계약을 10/18(한국) 에 종료 처리했다
      expect(await from([contract('2026-12-31', '2026-10-18T03:00:00Z')])).toBe(
        '2026-10-19',
      );
      expect(await from([contract('2026-10-10'), contract(null)])).toBe(
        '2026-11-01',
      );
      // 퇴직일과 계약 종료일 가운데 이른 쪽
      expect(await from([contract('2026-10-20')], '2026-10-25')).toBe(
        '2026-10-21',
      );
    });

    it('그 계약의 진행 중 갱신(체결 전)이 있으면 계약 종료일은 보지 않는다 — 퇴직일은 본다(api #206 리뷰)', async () => {
      count.mockResolvedValue(1);
      expect(await from([contract('2026-10-15')])).toBe('2026-11-01');
      expect(await from([contract('2026-10-15')], '2026-10-20')).toBe(
        '2026-10-21',
      );
      expect(count).toHaveBeenCalledWith({
        where: {
          staffMemberId: 7,
          status: {
            in: [
              'DRAFT',
              'PENDING_SEND',
              'PENDING_SIGNATURE',
              'CORRECTION_REQUESTED',
            ],
          },
          // 급여 기간 계약의 갱신만, 급여 기간 마지막 날까지 시작하는 것만 — 다음 달에 시작하는 갱신은 남은 날을 메우지 않는다
          previousContractId: { in: [1] },
          OR: [
            { startDate: null },
            { startDate: { lte: new Date('2026-10-31T00:00:00Z') } },
          ],
        },
      });
    });
  });

  it('확인 필요 문구 — 앞 달 날이 하루면 그 날 하나만, 앞 달 날 것이 없으면 「급여 기간에」', () => {
    expect(flaggedDetail(1, 1, ['2026-09-30'])).toBe(
      '급여 기간과 첫 주 앞 달 날(09-30)에 확인 필요 출퇴근 기록이 1건 있습니다',
    );
    expect(flaggedDetail(3, 0, ['2026-09-28', '2026-09-29'])).toBe(
      '급여 기간에 확인 필요 출퇴근 기록이 3건 있습니다',
    );
  });

  it('달을 걸친 첫 주의 앞 달 날(9/28 ~ 30)은 퇴근 미등록만 출퇴근 누락에 넣는다 — 기록 없음은 기간 안 날만 본다', async () => {
    const findMany = jest.fn().mockResolvedValue([
      // 9/29 출근만(퇴근 없음), 10/2 출근 · 퇴근
      {
        recordedAt: new Date('2026-09-29T00:00:00Z'),
        _count: { attendanceRecordsAsCheckIn: 0 },
      },
      {
        recordedAt: new Date('2026-10-02T00:00:00Z'),
        _count: { attendanceRecordsAsCheckIn: 1 },
      },
    ]);
    const db = {
      contract: {
        findMany: jest.fn().mockResolvedValue([
          {
            startDate: new Date('2026-10-01T00:00:00Z'),
            status: 'SIGNED',
            endDate: new Date('2026-10-02T00:00:00Z'),
            contractStatusHistories: [],
            contractWorkDays: [{ weekday: 'FRI' }],
          },
        ]),
      },
      staffMember: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ retiredDate: null }),
      },
      attendanceRecord: { findMany, count: jest.fn().mockResolvedValue(0) },
    };
    const basis = {
      staffMemberId: 7,
      contractIds: [1],
      periodStartDate: new Date('2026-10-01T00:00:00Z'),
      periodEndDate: new Date('2026-10-31T00:00:00Z'),
    };
    const now = new Date('2026-11-05T00:00:00Z');
    expect(await attendanceReviewReasons(db as never, basis, now)).toEqual([
      {
        reviewReason: 'MISSING_ATTENDANCE',
        detail: missingDetail([{ date: '2026-09-29', kind: 'NO_CHECK_OUT' }]),
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recordedAt: {
            gte: new Date('2026-09-27T15:00:00Z'),
            lt: new Date('2026-10-31T15:00:00Z'),
          },
        }) as unknown,
      }),
    );
    // 기간 안 출근이 없으면 앞 날 기록이 있어도 「기록이 없습니다」
    findMany.mockResolvedValueOnce([
      {
        recordedAt: new Date('2026-09-29T00:00:00Z'),
        _count: { attendanceRecordsAsCheckIn: 0 },
      },
    ]);
    expect(await attendanceReviewReasons(db as never, basis, now)).toEqual([
      { reviewReason: 'MISSING_ATTENDANCE', detail: NO_ATTENDANCE_DETAIL },
    ]);
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

    it('기간 앞 날은 퇴근 미등록만 맨 뒤에 내림차순으로 — 출근 · 퇴근 모두 없는 앞 날은 넣지 않는다', () => {
      const checkedIn = new Map([
        ['2026-08-31', false],
        ['2026-09-02', true],
        ['2026-09-04', true],
        ['2026-09-07', true],
        ['2026-09-09', true],
        ['2026-09-11', true],
      ]);
      expect(
        missingDays({
          ...base,
          periodStart: '2026-09-02',
          checkedIn,
          leadDays: ['2026-08-31', '2026-09-01'],
        }),
      ).toEqual([{ date: '2026-08-31', kind: 'NO_CHECK_OUT' }]);
      checkedIn.delete('2026-09-09');
      checkedIn.set('2026-09-01', false);
      expect(
        missingDays({
          ...base,
          periodStart: '2026-09-02',
          checkedIn,
          leadDays: ['2026-08-31', '2026-09-01'],
        }),
      ).toEqual([
        { date: '2026-09-09', kind: 'NONE' },
        { date: '2026-09-01', kind: 'NO_CHECK_OUT' },
        { date: '2026-08-31', kind: 'NO_CHECK_OUT' },
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
