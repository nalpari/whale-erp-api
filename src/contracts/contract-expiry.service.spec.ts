import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ContractExpiryService, needsRenewal } from './contract-expiry.service';

describe('ContractExpiryService (근로계약 하루 배치)', () => {
  let service: ContractExpiryService;
  let tx: {
    $executeRaw: jest.Mock;
    contract: { updateManyAndReturn: jest.Mock; findMany: jest.Mock };
    contractStatusHistory: { createManyAndReturn: jest.Mock };
    invitation: { updateMany: jest.Mock };
  };
  // 한국 시간 2026-10-07 00:00 — 배치가 도는 자정
  const now = new Date('2026-10-06T15:00:00Z');
  const TODAY = new Date('2026-10-07T00:00:00Z');
  const RENEWAL_END = new Date('2026-11-06T00:00:00Z');

  /** updateManyAndReturn 은 서명 대기 만료 → 종료 → 갱신 예정 표시 차례로 불린다 */
  const changed = (...lists: number[][]) => {
    for (const ids of lists)
      tx.contract.updateManyAndReturn.mockResolvedValueOnce(
        ids.map((contractId) => ({ contractId })),
      );
  };

  beforeEach(async () => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      contract: {
        updateManyAndReturn: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      contractStatusHistory: {
        // 바뀐 계약마다 이력 하나 — 이력 ID 는 계약 ID + 100
        createManyAndReturn: jest.fn(
          (args: { data: { contractId: number }[] }) =>
            Promise.resolve(
              args.data.map(({ contractId }) => ({
                contractId,
                contractStatusHistoryId: contractId + 100,
              })),
            ),
        ),
      },
      invitation: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ContractExpiryService],
    }).compile();
    service = module.get(ContractExpiryService);
  });

  const run = () =>
    service.runDaily(tx as unknown as Prisma.TransactionClient, now);
  const argsOf = (i: number) =>
    (tx.contract.updateManyAndReturn.mock.calls[i] as [{ where: unknown }])[0];

  it('날인 기한이 지난 서명 대기 계약만 만료로 바꾸고 이력 ID 를 함께 돌려준다 — 발송 대기는 만료하지 않는다(재발송할 수 있게, api #150 리뷰)', async () => {
    changed([1, 2]);

    const result = await run();

    expect(argsOf(0).where).toEqual({
      signDeadlineAt: { lte: now },
      status: 'PENDING_SIGNATURE',
    });
    expect(result.expired).toEqual([
      { contractId: 1, historyId: 101 },
      { contractId: 2, historyId: 102 },
    ]);
    const statuses = tx.contract.updateManyAndReturn.mock.calls.map(
      ([a]) => (a as { where: { status?: string } }).where.status,
    );
    expect(statuses).not.toContain('PENDING_SEND');
  });

  it('바꿀 계약 · 초대의 직원 행을 id 순으로 먼저 잠근다 — 퇴직 확정 · 가입 · 계약 대체와 같은 순서(직원 → 초대 → 계약)', async () => {
    changed([1]);

    await run();

    const [sql] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray];
    const text = sql.join('?');
    expect(text).toMatch(
      /FROM staff_members[\s\S]*ORDER BY staff_member_id\s+FOR NO KEY UPDATE/,
    );
    // 종료 · 갱신 예정 대상(종료일이 범위 끝까지인 체결 완료)의 직원도 잡는다
    expect(text).toMatch(/status = 'SIGNED' AND end_date <=/);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.contract.updateManyAndReturn.mock.invocationCallOrder[0],
    );
  });

  it('기한이 지난 「보냄」 초대를 만료로 바꾼다', async () => {
    const result = await run();

    expect(tx.invitation.updateMany).toHaveBeenCalledWith({
      where: { status: 'SENT', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    expect(result.invitationsExpired).toBe(3);
  });

  it('계약 종료일이 한국 날짜로 오늘보다 앞인 체결 완료 계약을 종료로 바꾼다', async () => {
    changed([], [7]);

    const result = await run();

    expect(argsOf(1).where).toEqual({
      endDate: { lt: TODAY },
      status: 'SIGNED',
    });
    expect(result.ended).toEqual([7]);
  });

  it('종료일이 오늘부터 30일 안인 재직 직원의 체결 완료 가운데 갱신이 필요한 것에만 보낸 때를 남긴다 — 계약마다 한 번', async () => {
    const end = new Date('2026-10-20T00:00:00Z');
    tx.contract.findMany.mockResolvedValue([
      // 갱신 필요
      {
        contractId: 9,
        endDate: end,
        staffMember: { retiredDate: null, contracts: [] },
      },
      // 새 계약이 이미 진행 중 — 이미 갱신했다
      {
        contractId: 10,
        endDate: end,
        staffMember: {
          retiredDate: null,
          contracts: [
            { contractId: 11, status: 'PENDING_SIGNATURE', endDate: null },
          ],
        },
      },
    ]);
    changed([], [], [9]);

    const result = await run();

    expect(tx.contract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'SIGNED',
          renewalNotifiedAt: null,
          endDate: { gte: TODAY, lte: RENEWAL_END },
          staffMember: { employmentStatus: 'EMPLOYED' },
        },
      }),
    );
    expect(argsOf(2)).toEqual({
      where: { contractId: { in: [9] }, renewalNotifiedAt: null },
      data: { renewalNotifiedAt: now },
      select: { contractId: true },
    });
    expect(result.renewalDue).toEqual([9]);
  });

  it('대상이 없으면 이력을 쓰지 않고 빈 결과다', async () => {
    tx.invitation.updateMany.mockResolvedValue({ count: 0 });

    await expect(run()).resolves.toEqual({
      expired: [],
      invitationsExpired: 0,
      ended: [],
      renewalDue: [],
    });
    expect(tx.contractStatusHistory.createManyAndReturn).not.toHaveBeenCalled();
    // 갱신 예정 후보가 없으면 표시하지 않는다
    expect(tx.contract.updateManyAndReturn).toHaveBeenCalledTimes(2);
  });
});

describe('needsRenewal (갱신 예정 — 이 계약의 종료일 기준)', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const candidate = (
    o: {
      retiredDate?: Date | null;
      contracts?: {
        contractId: number;
        status: 'DRAFT' | 'SIGNED' | 'ENDED' | 'PENDING_SEND';
        endDate: Date | null;
      }[];
    } = {},
  ) => ({
    contractId: 1,
    endDate: d('2026-11-01'),
    staffMember: {
      retiredDate: o.retiredDate ?? null,
      contracts: [
        { contractId: 1, status: 'SIGNED' as const, endDate: d('2026-11-01') },
        ...(o.contracts ?? []),
      ],
    },
  });

  it('다른 계약 없이 끝나면 갱신이 필요하다', () => {
    expect(needsRenewal(candidate())).toBe(true);
  });

  it('새 계약이 진행 중이면 필요 없다', () => {
    expect(
      needsRenewal(
        candidate({
          contracts: [{ contractId: 2, status: 'DRAFT', endDate: null }],
        }),
      ),
    ).toBe(false);
  });

  it('이 계약보다 늦게 끝나는 체결 완료가 있으면 필요 없다 — 그 계약도 30일 안에 끝나도(범위 끝이 아니라 이 계약의 종료일과 견줌)', () => {
    expect(
      needsRenewal(
        candidate({
          contracts: [
            { contractId: 2, status: 'SIGNED', endDate: d('2026-11-20') },
          ],
        }),
      ),
    ).toBe(false);
    // 기간의 정함이 없는 체결 완료
    expect(
      needsRenewal(
        candidate({
          contracts: [{ contractId: 2, status: 'SIGNED', endDate: null }],
        }),
      ),
    ).toBe(false);
  });

  it('먼저 끝나는 체결 완료 · 종료된 계약은 갱신으로 보지 않는다', () => {
    expect(
      needsRenewal(
        candidate({
          contracts: [
            { contractId: 2, status: 'SIGNED', endDate: d('2026-10-15') },
            { contractId: 3, status: 'ENDED', endDate: d('2027-01-01') },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('종료일까지 퇴직하면 필요 없고, 종료일 뒤 퇴직이면 그때까지 계속 일하므로 필요하다', () => {
    expect(needsRenewal(candidate({ retiredDate: d('2026-11-01') }))).toBe(
      false,
    );
    expect(needsRenewal(candidate({ retiredDate: d('2026-11-20') }))).toBe(
      true,
    );
  });
});
