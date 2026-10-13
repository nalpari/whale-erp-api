import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  checkReplace,
  checkWorkTimeOverlap,
  dropOrphanRecords,
  periodsOverlap,
  replaceContracts,
  shiftOverlaps,
} from './contract-duplicates';
import { CreateContractDto } from './dto/create-contract.dto';

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
    { contractId: 7, status: 'DRAFT' as const, staffMemberId: 3 },
    { contractId: 9, status: 'PENDING_SIGNATURE' as const, staffMemberId: 4 },
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
  const db = () => ({
    contract: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    contractWorkDay: { deleteMany: jest.fn() },
    contractParty: { deleteMany: jest.fn() },
    contractStatusHistory: { deleteMany: jest.fn(), create: jest.fn() },
  });

  it('임시저장은 행을 지운다 — 상태가 그대로일 때만', async () => {
    const d = db();
    await replaceContracts(d as unknown as Prisma.TransactionClient, [
      { contractId: 7, status: 'DRAFT', staffMemberId: 3 },
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
    const d = db();
    await replaceContracts(d as unknown as Prisma.TransactionClient, [
      { contractId: 9, status: 'PENDING_SIGNATURE', staffMemberId: 4 },
    ]);
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

  it('읽은 뒤 다른 요청이 상태를 바꿨으면(0건) 이력을 남기지 않는다', async () => {
    const d = db();
    d.contract.updateMany.mockResolvedValue({ count: 0 });
    await replaceContracts(d as unknown as Prisma.TransactionClient, [
      { contractId: 9, status: 'PENDING_SEND', staffMemberId: 4 },
    ]);
    expect(d.contractStatusHistory.create).not.toHaveBeenCalled();
  });
});

describe('dropOrphanRecords', () => {
  it('새 계약이 쓰는 레코드는 빼고, 계약이 남지 않은 가입 전 레코드만 지운다', async () => {
    const deleteMany = jest.fn();
    const db = { staffMember: { deleteMany } };
    await dropOrphanRecords(
      db as unknown as Prisma.TransactionClient,
      [3, 4, 3],
      3,
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        staffMemberId: { in: [4] },
        joinStatus: { not: 'JOINED' },
        contracts: { none: {} },
      },
    });
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
        status: { in: ['PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED'] },
        staffMember: { phone: '01090145563' },
      },
      select: {
        startDate: true,
        endDate: true,
        contractWorkDays: {
          select: { weekday: true, startTime: true, endTime: true },
        },
      },
    });
  });

  it('겹치면 409 — 겹친 요일 · 시간만 알리고 점포는 드러내지 않는다', async () => {
    const { db: d } = db([other]);
    await expect(
      checkWorkTimeOverlap(d as unknown as Prisma.TransactionClient, dto()),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'WORK_TIME_OVERLAP',
        message:
          '다른 점포 근로계약과 근무 시간이 겹칩니다(월 14:00-16:00). 근무 시간을 고쳐 주세요',
        overlaps: [{ weekday: 'MON', startTime: '14:00', endTime: '16:00' }],
      },
    });
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
