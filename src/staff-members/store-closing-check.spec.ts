import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';
import { PENDING_CONTRACT_STATUSES } from './retirement.service';
import { storeClosingCheck } from './store-closing-check';

const consented = {
  isHqSharingConsented: true,
  hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
};
const row = (
  id: number,
  name: string,
  account: typeof consented | null,
  recordedAt: string,
) => ({
  attendanceRecordId: id,
  recordedAt: new Date(recordedAt),
  staffMember: { staffMemberId: id * 10, name, account },
});

describe('폐점 확인 storeClosingCheck (WHALEERP-647)', () => {
  const now = new Date('2026-11-03T01:00:00Z');
  const closedDate = new Date('2026-11-03T00:00:00Z');
  const setup = (opts: {
    store?: { storeTypeCode: string; storeStatusCode: string };
    rows?: ReturnType<typeof row>[];
  }) => {
    const db = {
      store: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(
          opts.store ?? {
            storeTypeCode: 'FRANCHISE',
            storeStatusCode: 'OPERATING',
          },
        ),
      },
      attendanceRecord: {
        findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      },
      contract: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'DRAFT', _count: { _all: 3 } },
          { status: 'PENDING_SEND', _count: { _all: 1 } },
          { status: 'PENDING_SIGNATURE', _count: { _all: 2 } },
          { status: 'CORRECTION_REQUESTED', _count: { _all: 1 } },
        ]),
      },
      staffMember: { count: jest.fn().mockResolvedValue(4) },
      payslip: { count: jest.fn().mockResolvedValue(2) },
    };
    return {
      db,
      run: () => storeClosingCheck(db as never, 7, closedDate, now),
    };
  };
  // 가린 직원(동의 없음)이 더 이르다
  const rows = [
    row(1, '나미동의', null, '2026-11-02T00:00:00Z'),
    row(2, '가동의', consented, '2026-11-02T02:00:00Z'),
  ];

  it('퇴직될 직원 · 계약은 retireStore 와 같은 이름 · 범위 — 재직이면서 가입했거나 임시저장 아닌 계약이 있는 직원, 점포의 대기 계약을 상태별로', async () => {
    const { db, run } = setup({});
    await expect(run()).resolves.toMatchObject({
      retiringStaff: 4,
      draftContracts: 3,
      pendingSendContracts: 1,
      // 서명 대기 + 수정 요청
      pendingSignatureContracts: 3,
      unconfirmedPayslips: 2,
    });
    const retiring = {
      storeId: 7,
      employmentStatus: 'EMPLOYED',
      OR: [
        { joinStatus: 'JOINED' },
        { contracts: { some: { status: { not: 'DRAFT' } } } },
      ],
    };
    expect(db.staffMember.count).toHaveBeenCalledWith({ where: retiring });
    expect(db.contract.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { storeId: 7, status: { in: PENDING_CONTRACT_STATUSES } },
      _count: { _all: true },
    });
    expect(db.payslip.count).toHaveBeenCalledWith({
      where: { storeId: 7, status: { in: ['DRAFTING', 'REVIEWING'] } },
    });
  });

  it('본사 역할에게 가려지는 직원(미동의 가맹)은 부르는 관리자와 상관없이 첫 건으로 고르지 않고 hiddenCount 로만 센다', async () => {
    const { run } = setup({ rows });
    const { openCheckIns } = await run();
    expect(openCheckIns).toEqual({
      count: 1,
      hiddenCount: 1,
      first: {
        attendanceRecordId: 2,
        staffMemberId: 20,
        name: '가동의',
        recordedAt: new Date('2026-11-02T02:00:00Z'),
        isCheckOutExpired: false,
      },
    });
  });

  it('직영 점포는 가리지 않는다 — 가장 이른 것이 첫 건이다', async () => {
    const { openCheckIns } = await setup({
      rows,
      store: { storeTypeCode: 'DIRECT', storeStatusCode: 'OPERATING' },
    }).run();
    expect(openCheckIns.count).toBe(2);
    expect(openCheckIns.hiddenCount).toBe(0);
    expect(openCheckIns.first?.name).toBe('나미동의');
  });

  it('폐점한 가맹 점포면 동의한 직원도 가린다 — first 는 null, 합계는 그대로', async () => {
    const { openCheckIns } = await setup({
      rows,
      store: { storeTypeCode: 'FRANCHISE', storeStatusCode: 'CLOSED' },
    }).run();
    expect(openCheckIns).toEqual({ count: 0, hiddenCount: 2, first: null });
  });

  it('열린 출근이 없으면 0 · null', async () => {
    const { openCheckIns } = await setup({}).run();
    expect(openCheckIns).toEqual({ count: 0, hiddenCount: 0, first: null });
  });
});
