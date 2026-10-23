import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  checkReplace,
  checkWorkTimeOverlap,
  dropOrphanRecords,
  InProgressContract,
  periodsOverlap,
  replaceContracts,
  shiftOverlaps,
} from './contract-duplicates';
import { CreateContractDto } from './dto/create-contract.dto';

// 409 확인창에 싣는 사람 · 기간 — 중복 판정에는 쓰지 않는다
const WHO = { startDate: null, endDate: null, staffMember: { name: '남도현' } };

const conflictBody = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return (e as ConflictException).getResponse() as Record<string, unknown>;
  }
  throw new Error('409 가 나지 않았다');
};

describe('periodsOverlap', () => {
  it.each([
    [
      '맞닿는 날도 겹친다',
      ['2026-01-01', '2026-03-31'],
      ['2026-03-31', null],
      true,
    ],
    [
      '앞 계약이 끝난 다음 날 시작하면 겹치지 않는다',
      ['2026-01-01', '2026-03-31'],
      ['2026-04-01', null],
      false,
    ],
    [
      '종료일이 없으면 끝없이 이어진다',
      ['2026-01-01', null],
      ['2030-01-01', '2030-12-31'],
      true,
    ],
    [
      '시작일이 없으면 처음부터로 본다',
      [null, '2026-01-31'],
      ['2026-01-15', null],
      true,
    ],
    [
      '뒤 계약이 앞 계약 시작 전에 끝나면 겹치지 않는다',
      ['2026-05-01', null],
      ['2026-01-01', '2026-04-30'],
      false,
    ],
  ] as const)('%s', (_, [as, ae], [bs, be], expected) => {
    expect(periodsOverlap({ start: as, end: ae }, { start: bs, end: be })).toBe(
      expected,
    );
    expect(periodsOverlap({ start: bs, end: be }, { start: as, end: ae })).toBe(
      expected,
    );
  });
});

describe('shiftOverlaps', () => {
  const h = (n: number) => n * 60;

  it('같은 요일에서 겹친 구간만 준다', () => {
    expect(
      shiftOverlaps(
        [{ weekday: 'MON', start: h(10), end: h(16) }],
        [{ weekday: 'MON', start: h(14), end: h(20) }],
      ),
    ).toEqual([{ weekday: 'MON', start: h(14), end: h(16) }]);
  });

  it('맞닿기만 하면(10:00 종업 · 10:00 시업) 겹치지 않는다', () => {
    expect(
      shiftOverlaps(
        [{ weekday: 'MON', start: h(10), end: h(14) }],
        [{ weekday: 'MON', start: h(6), end: h(10) }],
      ),
    ).toEqual([]);
  });

  it('요일이 다르면 겹치지 않는다', () => {
    expect(
      shiftOverlaps(
        [{ weekday: 'MON', start: h(10), end: h(14) }],
        [{ weekday: 'TUE', start: h(10), end: h(14) }],
      ),
    ).toEqual([]);
  });

  it('같은 요일 구간은 이어 붙이고, 요일 순서(월→일)로 준다', () => {
    expect(
      shiftOverlaps(
        [
          { weekday: 'SUN', start: h(9), end: h(12) },
          { weekday: 'MON', start: h(9), end: h(18) },
        ],
        [
          { weekday: 'MON', start: h(13), end: h(15) },
          { weekday: 'MON', start: h(10), end: h(13) },
          { weekday: 'SUN', start: h(11), end: h(20) },
        ],
      ),
    ).toEqual([
      { weekday: 'MON', start: h(10), end: h(15) },
      { weekday: 'SUN', start: h(11), end: h(12) },
    ]);
  });
});

describe('checkReplace', () => {
  const current = [
    { contractId: 7, status: 'DRAFT' as const, staffMemberId: 3, ...WHO },
    {
      contractId: 9,
      status: 'PENDING_SIGNATURE' as const,
      staffMemberId: 4,
      ...WHO,
    },
  ];

  it('진행 중 계약이 없으면 지나간다 — 대체 확인 값은 보지 않는다', () => {
    expect(() => checkReplace([], undefined)).not.toThrow();
    expect(() => checkReplace([], [7])).not.toThrow();
  });

  it('확인 없이 오면 409 와 진행 중 계약 목록을 준다', () => {
    const body = conflictBody(() => checkReplace(current, undefined));
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'CONTRACT_IN_PROGRESS',
      contracts: [
        { contractId: 7, status: 'DRAFT' },
        { contractId: 9, status: 'PENDING_SIGNATURE' },
      ],
    });
  });

  it('확인한 목록이 지금 목록과 다르면(빠졌거나 남는 것이 있으면) 다시 묻는다', () => {
    expect(() => checkReplace(current, [7])).toThrow(ConflictException);
    expect(() => checkReplace(current, [7, 9, 11])).toThrow(ConflictException);
  });

  it('모두 확인했으면 지나간다 (순서 · 중복은 상관없다)', () => {
    expect(() => checkReplace(current, [9, 7, 7])).not.toThrow();
  });
});

describe('replaceContracts', () => {
  const at = { storeId: 11, phone: '01090145563' };
  // 잠근 뒤 다시 읽은 계약 — 기본은 대체를 물을 때와 같다.
  const db = (status: string) => {
    const calls: string[] = [];
    const track =
      (name: string, value?: unknown) =>
      (...args: unknown[]) => {
        calls.push(name);
        void args;
        return Promise.resolve(value);
      };
    return {
      calls,
      $executeRaw: jest.fn(track('lock', 1)),
      contract: {
        findUnique: jest.fn().mockResolvedValue({
          status,
          storeId: 11,
          staffMember: { phone: '01090145563' },
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      contractWorkDay: { deleteMany: jest.fn(track('workDay')) },
      contractParty: { deleteMany: jest.fn() },
      contractStatusHistory: { deleteMany: jest.fn(), create: jest.fn() },
      invitation: { updateMany: jest.fn() },
    };
  };
  const run = (d: ReturnType<typeof db>, c: InProgressContract) =>
    replaceContracts(d as unknown as Prisma.TransactionClient, [c], at);

  it('임시저장은 직원 행 · 계약 행을 먼저 잠근 뒤 행을 지운다 — 상태가 그대로일 때만', async () => {
    const d = db('DRAFT');
    await run(d, { contractId: 7, status: 'DRAFT', staffMemberId: 3, ...WHO });
    expect(d.calls).toEqual(['lock', 'lock', 'workDay']);
    // 직원 행(FOR NO KEY UPDATE) → 계약 행 — 가입 전 직원 레코드를 지울 수 있다(api #104)
    expect(
      d.$executeRaw.mock.calls.map((c: unknown[]) => [
        (c[0] as string[]).join('?'),
        c[1],
      ]),
    ).toEqual([
      [expect.stringMatching(/FROM staff_members .* FOR NO KEY UPDATE$/), 3],
      [expect.stringMatching(/FROM contracts .* FOR UPDATE$/), 7],
    ]);
    for (const m of [
      d.contractWorkDay,
      d.contractParty,
      d.contractStatusHistory,
    ])
      expect(m.deleteMany).toHaveBeenCalledWith({ where: { contractId: 7 } });
    expect(d.contract.deleteMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'DRAFT' },
    });
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });

  it('발송 대기 · 서명 대기는 종료로 닫고 이력을 남긴다', async () => {
    const d = db('PENDING_SIGNATURE');
    await run(d, {
      contractId: 9,
      status: 'PENDING_SIGNATURE',
      staffMemberId: 4,
      ...WHO,
    });
    expect(d.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 9, status: 'PENDING_SIGNATURE' },
      data: { status: 'ENDED' },
    });
    expect(d.contractStatusHistory.create).toHaveBeenCalledWith({
      data: {
        contractId: 9,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'ENDED',
        actor: 'ADMIN',
      },
    });
    expect(d.contract.deleteMany).not.toHaveBeenCalled();
  });

  it('대체된 계약의 직원 레코드에 나가 있던 초대는 무효로 한다 — 종료된 계약으로 이어지는 링크를 남기지 않는다(api #65 재리뷰)', async () => {
    const d = db('PENDING_SEND');
    await run(d, {
      contractId: 9,
      status: 'PENDING_SEND',
      staffMemberId: 4,
      ...WHO,
    });
    expect(d.invitation.updateMany).toHaveBeenCalledWith({
      where: { staffMemberId: { in: [4] }, status: 'SENT' },
      data: { status: 'EXPIRED' },
    });
  });

  it.each([
    ['지워졌으면', null],
    [
      '상태가 바뀌었으면',
      { status: 'SIGNED', storeId: 11, staffMember: { phone: '01090145563' } },
    ],
    [
      '점포가 바뀌었으면',
      {
        status: 'PENDING_SEND',
        storeId: 12,
        staffMember: { phone: '01090145563' },
      },
    ],
    [
      '이어 쓰기로 번호가 바뀌었으면',
      {
        status: 'PENDING_SEND',
        storeId: 11,
        staffMember: { phone: '01011112222' },
      },
    ],
  ])('잠근 뒤 다시 읽어 %s 409 — 아무것도 고치지 않는다', async (_, now) => {
    const d = db('PENDING_SEND');
    d.contract.findUnique.mockResolvedValue(now);
    await expect(
      run(d, {
        contractId: 9,
        status: 'PENDING_SEND',
        staffMemberId: 4,
        ...WHO,
      }),
    ).rejects.toThrow(ConflictException);
    expect(d.contract.updateMany).not.toHaveBeenCalled();
    expect(d.contractWorkDay.deleteMany).not.toHaveBeenCalled();
  });

  it('조건부 종료 · 삭제가 0건이면 409 — 이력을 남기지 않는다', async () => {
    const d = db('PENDING_SEND');
    d.contract.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      run(d, {
        contractId: 9,
        status: 'PENDING_SEND',
        staffMemberId: 4,
        ...WHO,
      }),
    ).rejects.toThrow(ConflictException);
    expect(d.contractStatusHistory.create).not.toHaveBeenCalled();

    const draft = db('DRAFT');
    draft.contract.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      run(draft, { contractId: 7, status: 'DRAFT', staffMemberId: 3, ...WHO }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('dropOrphanRecords', () => {
  it('새 계약이 쓰는 레코드는 빼고, 계약이 남지 않은 가입 전 레코드만 지운다 — 그 레코드를 가리키는 재입사 연결을 먼저 끊는다', async () => {
    const deleteMany = jest.fn();
    const updateMany = jest.fn();
    const db = { staffMember: { deleteMany, updateMany } };
    await dropOrphanRecords(
      db as unknown as Prisma.TransactionClient,
      [3, 4, 3],
      3,
    );
    const orphan = {
      staffMemberId: { in: [4] },
      joinStatus: { not: 'JOINED' },
      contracts: { none: {} },
    };
    expect(updateMany).toHaveBeenCalledWith({
      where: { previousStaffMember: orphan },
      data: { previousStaffMemberId: null },
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: orphan });
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('지울 후보가 없으면 묻지 않는다', async () => {
    const deleteMany = jest.fn();
    const db = { staffMember: { deleteMany } };
    await dropOrphanRecords(db as unknown as Prisma.TransactionClient, [3], 3);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('checkWorkTimeOverlap', () => {
  const t = (hm: string) => new Date(`1970-01-01T${hm}:00.000Z`);
  const dto = (over: Partial<CreateContractDto> = {}): CreateContractDto => ({
    name: '남도현',
    phone: '01090145563',
    storeId: 11,
    jobTitle: '바리스타',
    employmentType: 'PART_TIME',
    startDate: '2026-11-01',
    workDays: [
      { weekday: 'MON', startTime: '10:00', endTime: '16:00' },
      { weekday: 'WED', startTime: '10:00', endTime: '16:00' },
    ],
    ...over,
  });
  const other = {
    startDate: new Date('2026-09-01T00:00:00.000Z'),
    endDate: null,
    staffMember: { retiredDate: null as Date | null },
    contractWorkDays: [
      { weekday: 'MON', startTime: t('14:00'), endTime: t('20:00') },
      { weekday: 'TUE', startTime: t('10:00'), endTime: t('16:00') },
    ],
  };
  const db = (rows: unknown[]) => {
    const findMany = jest.fn().mockResolvedValue(rows);
    return { db: { contract: { findMany } }, findMany };
  };

  it('다른 점포 · 같은 번호의 발송 대기~체결 완료 계약을 본다', async () => {
    const { db: d, findMany } = db([]);
    await checkWorkTimeOverlap(d as unknown as Prisma.TransactionClient, dto());
    expect(findMany).toHaveBeenCalledWith({
      where: {
        storeId: { not: 11 },
        status: {
          in: [
            'PENDING_SEND',
            'PENDING_SIGNATURE',
            'CORRECTION_REQUESTED',
            'SIGNED',
          ],
        },
        staffMember: { phone: '01090145563' },
      },
      select: {
        startDate: true,
        endDate: true,
        staffMember: { select: { retiredDate: true } },
        contractWorkDays: {
          select: { weekday: true, startTime: true, endTime: true },
        },
      },
    });
  });

  it('겹치면 409 — 겹쳤다는 것만 알리고 요일 · 시각 · 점포는 드러내지 않는다 (CTR-26)', async () => {
    const { db: d } = db([other]);
    const error = await checkWorkTimeOverlap(
      d as unknown as Prisma.TransactionClient,
      dto(),
    ).catch((e: ConflictException) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'WORK_TIME_OVERLAP',
      message: '다른 점포 근로계약과 근무 시간이 겹칩니다',
    });
  });

  it('퇴직한 직원 레코드의 계약은 퇴직일까지만 본다', async () => {
    const retired = {
      ...other,
      staffMember: { retiredDate: new Date('2026-10-31T00:00:00.000Z') },
    };
    // 새 계약은 11-01 부터 — 퇴직일 뒤라 겹치지 않는다
    await expect(
      checkWorkTimeOverlap(
        db([retired]).db as unknown as Prisma.TransactionClient,
        dto(),
      ),
    ).resolves.toBeUndefined();
    // 퇴직일 전부터 시작하면 그 사이가 겹친다
    await expect(
      checkWorkTimeOverlap(
        db([retired]).db as unknown as Prisma.TransactionClient,
        dto({ startDate: '2026-10-15' }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('계약 기간이 겹치지 않으면 시간이 같아도 지나간다', async () => {
    const { db: d } = db([
      { ...other, endDate: new Date('2026-10-31T00:00:00.000Z') },
    ]);
    await expect(
      checkWorkTimeOverlap(d as unknown as Prisma.TransactionClient, dto()),
    ).resolves.toBeUndefined();
  });

  it('근무 요일이 없으면 묻지 않는다', async () => {
    const { db: d, findMany } = db([other]);
    await checkWorkTimeOverlap(
      d as unknown as Prisma.TransactionClient,
      dto({ workDays: [] }),
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
