import { NotFoundException } from '@nestjs/common';
import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';
import { editableStart } from '../attendance/attendance-rules';
import { PENDING_CONTRACT_STATUSES } from './retirement.service';
import { storeClosingCheck } from './store-closing-check';

const consented = {
  isHqSharingConsented: true,
  hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
};
const row = (
  storeId: number,
  id: number,
  name: string,
  account: typeof consented | null,
  recordedAt: string,
) => ({
  storeId,
  attendanceRecordId: id,
  recordedAt: new Date(recordedAt),
  staffMember: { staffMemberId: id * 10, name, account },
});
const operating = (storeId: number, storeTypeCode = 'FRANCHISE') => ({
  storeId,
  storeTypeCode,
  storeStatusCode: 'OPERATING',
});

describe('폐점 확인 storeClosingCheck (WHALEERP-647 · 650)', () => {
  const now = new Date('2026-11-03T01:00:00Z');
  const closedDate = new Date('2026-11-03T00:00:00Z');
  const setup = (
    opts: {
      stores?: ReturnType<typeof operating>[];
      rows?: ReturnType<typeof row>[];
    } = {},
  ) => {
    const db = {
      store: {
        findMany: jest.fn().mockResolvedValue(opts.stores ?? [operating(7)]),
      },
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      },
      contract: {
        groupBy: jest.fn().mockResolvedValue([
          { storeId: 7, status: 'DRAFT', _count: { _all: 3 } },
          { storeId: 7, status: 'PENDING_SEND', _count: { _all: 1 } },
          { storeId: 7, status: 'PENDING_SIGNATURE', _count: { _all: 2 } },
          { storeId: 7, status: 'CORRECTION_REQUESTED', _count: { _all: 1 } },
          { storeId: 8, status: 'DRAFT', _count: { _all: 5 } },
        ]),
      },
      staffMember: {
        groupBy: jest.fn().mockResolvedValue([
          { storeId: 7, _count: { _all: 4 } },
          { storeId: 8, _count: { _all: 6 } },
        ]),
      },
      payslip: {
        groupBy: jest
          .fn()
          .mockResolvedValue([{ storeId: 7, _count: { _all: 2 } }]),
      },
    };
    return {
      db,
      run: (ids: number[] = [7]) =>
        storeClosingCheck(db as never, ids, closedDate, now),
    };
  };
  const zero = {
    openCheckIns: { count: 0, hiddenCount: 0, first: null },
    retiringStaff: 0,
    draftContracts: 0,
    pendingSendContracts: 0,
    pendingSignatureContracts: 0,
    unconfirmedPayslips: 0,
  };
  const two = [operating(7), operating(8)];

  it('퇴직될 직원 · 계약은 retireStore 와 같은 이름 · 범위 — 점포마다 상태별로, 합계는 같은 칸의 합', async () => {
    const res = await setup({ stores: two }).run([7, 8]);
    const seven = {
      ...zero,
      retiringStaff: 4,
      draftContracts: 3,
      pendingSendContracts: 1,
      // 서명 대기 + 수정 요청
      pendingSignatureContracts: 3,
      unconfirmedPayslips: 2,
    };
    expect(res.stores).toEqual([
      { storeId: 7, ...seven },
      { storeId: 8, ...zero, retiringStaff: 6, draftContracts: 5 },
    ]);
    expect(res.total).toEqual({
      ...seven,
      retiringStaff: 10,
      draftContracts: 8,
    });
  });

  it('점포 수와 상관없이 표마다 쿼리 한 번 — IN 으로 한 번에 묻는다', async () => {
    const { db, run } = setup({ stores: two });
    await run([7, 8]);
    const ids = { in: [7, 8] };
    expect(db.store.findMany).toHaveBeenCalledTimes(1);
    expect(db.store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: ids, isDeleted: false } }),
    );
    expect(db.attendanceRecord.findMany).toHaveBeenCalledTimes(1);
    expect(db.attendanceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: ids,
          staffMember: { employmentStatus: 'EMPLOYED' },
          kind: 'CHECK_IN',
          attendanceRecordsAsCheckIn: { none: {} },
          recordedAt: { gte: editableStart() },
        },
      }),
    );
    expect(db.staffMember.groupBy).toHaveBeenCalledTimes(1);
    expect(db.staffMember.groupBy).toHaveBeenCalledWith({
      by: ['storeId'],
      where: {
        storeId: ids,
        employmentStatus: 'EMPLOYED',
        OR: [
          { joinStatus: 'JOINED' },
          { contracts: { some: { status: { not: 'DRAFT' } } } },
        ],
      },
      _count: { _all: true },
    });
    expect(db.contract.groupBy).toHaveBeenCalledTimes(1);
    expect(db.contract.groupBy).toHaveBeenCalledWith({
      by: ['storeId', 'status'],
      where: { storeId: ids, status: { in: PENDING_CONTRACT_STATUSES } },
      _count: { _all: true },
    });
    expect(db.payslip.groupBy).toHaveBeenCalledTimes(1);
    expect(db.payslip.groupBy).toHaveBeenCalledWith({
      by: ['storeId'],
      where: { storeId: ids, status: { in: ['DRAFTING', 'REVIEWING'] } },
      _count: { _all: true },
    });
  });

  it('본사 역할에게 가려지는 직원(미동의 가맹)은 첫 건으로 고르지 않고 hiddenCount 로만 센다 — 점포마다', async () => {
    const { stores, total } = await setup({
      stores: two,
      // 전체로 가장 이른 것(점포 7)은 가려진다
      rows: [
        row(7, 1, '나미동의', null, '2026-11-02T00:00:00Z'),
        row(8, 3, '다동의', consented, '2026-11-02T01:00:00Z'),
        row(7, 2, '가동의', consented, '2026-11-02T02:00:00Z'),
      ],
    }).run([7, 8]);
    const ga = {
      storeId: 7,
      attendanceRecordId: 2,
      staffMemberId: 20,
      name: '가동의',
      recordedAt: new Date('2026-11-02T02:00:00Z'),
      isCheckOutExpired: false,
    };
    const da = {
      storeId: 8,
      attendanceRecordId: 3,
      staffMemberId: 30,
      name: '다동의',
      recordedAt: new Date('2026-11-02T01:00:00Z'),
      isCheckOutExpired: false,
    };
    expect(stores[0].openCheckIns).toEqual({
      count: 1,
      hiddenCount: 1,
      first: ga,
    });
    expect(stores[1].openCheckIns).toEqual({
      count: 1,
      hiddenCount: 0,
      first: da,
    });
    // 합계의 첫 건은 보이는 것 가운데 전체에서 가장 이른 것 — 어느 점포인지 storeId 로 안다
    expect(total.openCheckIns).toEqual({ count: 2, hiddenCount: 1, first: da });
  });

  it('직영 점포는 가리지 않고, 폐점한 가맹 점포는 동의한 직원도 가린다 — 점포마다 그 점포 기준', async () => {
    const { stores, total } = await setup({
      stores: [
        operating(7, 'DIRECT'),
        { storeId: 8, storeTypeCode: 'FRANCHISE', storeStatusCode: 'CLOSED' },
      ],
      rows: [
        row(7, 1, '나미동의', null, '2026-11-02T00:00:00Z'),
        row(8, 2, '가동의', consented, '2026-11-02T02:00:00Z'),
      ],
    }).run([7, 8]);
    expect(stores[0].openCheckIns.count).toBe(1);
    expect(stores[0].openCheckIns.hiddenCount).toBe(0);
    expect(stores[0].openCheckIns.first?.name).toBe('나미동의');
    expect(stores[1].openCheckIns).toEqual({
      count: 0,
      hiddenCount: 1,
      first: null,
    });
    expect(total.openCheckIns.count + total.openCheckIns.hiddenCount).toBe(2);
  });

  it('모든 점포가 가려지면 합계도 count 0 · first null 이고 수는 hiddenCount 로 — 막을지 판단은 그 합으로 한다', async () => {
    const { total } = await setup({
      stores: two,
      rows: [
        row(7, 1, '나미동의', null, '2026-11-02T00:00:00Z'),
        row(8, 2, '다미동의', null, '2026-11-02T01:00:00Z'),
      ],
    }).run([7, 8]);
    expect(total.openCheckIns).toEqual({
      count: 0,
      hiddenCount: 2,
      first: null,
    });
  });

  it('합계의 첫 건은 시각이 같으면 기록 id 가 작은 것', async () => {
    const at = '2026-11-02T02:00:00Z';
    const { total } = await setup({
      stores: two,
      rows: [
        row(8, 1, '다동의', consented, at),
        row(7, 2, '가동의', consented, at),
      ],
    }).run([7, 8]);
    expect(total.openCheckIns.first?.attendanceRecordId).toBe(1);
  });

  it('출근한 다음 날이 지난 첫 건은 isCheckOutExpired', async () => {
    const { stores } = await setup({
      rows: [row(7, 1, '가동의', consented, '2026-10-30T02:00:00Z')],
    }).run();
    expect(stores[0].openCheckIns.first?.isCheckOutExpired).toBe(true);
  });

  it('빈 배열이면 쿼리 없이 빈 목록과 0', async () => {
    const { db, run } = setup();
    await expect(run([])).resolves.toEqual({ stores: [], total: zero });
    for (const query of [
      db.store.findMany,
      db.attendanceRecord.findMany,
      db.contract.groupBy,
      db.staffMember.groupBy,
      db.payslip.groupBy,
    ])
      expect(query).not.toHaveBeenCalled();
  });

  it('중복 id 는 한 번만 — 목록은 id 오름차순', async () => {
    // 자릿수가 달라야 숫자 순인지 드러난다 — 문자열 순이면 10 이 앞선다
    const { db, run } = setup({ stores: [operating(9), operating(10)] });
    const res = await run([10, 9, 10]);
    expect(res.stores.map((s) => s.storeId)).toEqual([9, 10]);
    expect(db.store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: { in: [9, 10] }, isDeleted: false },
      }),
    );
  });

  it('없거나 지운 점포가 섞이면 404 — 일부만 세어 돌려주지 않고 어느 점포인지 문구에 싣는다', async () => {
    const run = setup().run([7, 9, 11]);
    await expect(run).rejects.toBeInstanceOf(NotFoundException);
    await expect(run).rejects.toThrow('(9, 11)');
  });
});
