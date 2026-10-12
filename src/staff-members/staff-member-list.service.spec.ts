import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberListService } from './staff-member-list.service';

// 2026-10-14(수) 한국 12시. 이번 주는 2026-10-12(월) 한국 0시 = 2026-10-11T15:00Z 부터.
const NOW = new Date('2026-10-14T03:00:00Z');

const row = (over: object = {}) => ({
  staffMemberId: 30,
  storeId: 5,
  name: '서지안',
  phone: '01028417702',
  employmentType: 'FULL_TIME',
  joinStatus: 'JOINED',
  employmentStatus: 'EMPLOYED',
  retiredDate: null,
  invitations: [],
  ...over,
});

describe('StaffMemberListService', () => {
  let service: StaffMemberListService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    staffMember: { findMany: jest.Mock; count: jest.Mock };
    store: { findMany: jest.Mock };
    contract: { findMany: jest.Mock };
    workSchedule: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 5, storeTypeCode: 'DIRECT' },
          { storeId: 6, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
    prisma = {
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      staffMember: {
        findMany: jest.fn().mockResolvedValue([row()]),
        count: jest.fn().mockResolvedValue(1),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 5, name: '모리커피 서초점', storeTypeCode: 'DIRECT' },
          { storeId: 6, name: '모리커피 청담점', storeTypeCode: 'FRANCHISE' },
        ]),
      },
      contract: { findMany: jest.fn().mockResolvedValue([]) },
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        StaffMemberListService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(StaffMemberListService);
  });

  /** 목이 받은 첫 호출의 인자. 목 호출 기록은 any 라 린트(no-unsafe-*)를 지나도록 모양을 붙인다. */
  const firstArg = (mock: jest.Mock) =>
    (mock.mock.calls[0] as [Record<string, unknown>])[0];
  const where = () =>
    firstArg(prisma.staffMember.findMany).where as { AND: unknown[] };

  it('사용 중인 관리자가 아니면 null', async () => {
    scope.getManageableStores.mockResolvedValue(null);
    await expect(service.list(9, {}, NOW)).resolves.toBeNull();
    expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
  });

  it('관리 범위와 storeIds 의 교집합이 비면 쿼리 없이 빈 목록', async () => {
    await expect(service.list(9, { storeIds: [99] }, NOW)).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
  });

  it('범위 밖 storeIds 는 조용히 빠진다', async () => {
    await service.list(9, { storeIds: [5, 99] }, NOW);
    expect(where().AND).toContainEqual({ storeId: { in: [5] } });
  });

  it('페이지 · 정렬 · count 가 같은 where 를 쓴다', async () => {
    await service.list(9, { page: 3, pageSize: 10 }, NOW);
    const args = firstArg(prisma.staffMember.findMany);
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ staffMemberId: 'desc' });
    expect(prisma.staffMember.count).toHaveBeenCalledWith({
      where: args.where,
    });
  });

  it('keyword 는 이름과, 숫자만 남긴 번호로 찾는다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'FM',
      stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
    });
    await service.list(9, { keyword: '010-2841' }, NOW);
    expect(where().AND).toContainEqual({
      OR: [
        { name: { contains: '010-2841', mode: 'insensitive' } },
        { phone: { contains: '0102841' } },
      ],
    });
  });

  it('필터가 있으면 BM · BA 에게 가맹 점포를 뺀다 — 가린 행이 검색으로 드러나지 않게', async () => {
    await service.list(9, { keyword: '홍길동' }, NOW);
    expect(where().AND).toContainEqual({ storeId: { in: [5] } });
  });

  it('필터가 없으면 BM · BA 도 가맹 점포를 포함하고 그 줄을 가린다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({ staffMemberId: 31, storeId: 6, name: '가맹직원' }),
    ]);
    const res = await service.list(9, {}, NOW);
    expect(where().AND).toContainEqual({ storeId: { in: [5, 6] } });
    expect(res!.items[0]).toEqual({
      staffMemberId: 31,
      isMasked: true,
      name: null,
      phone: null,
      store: { storeId: 6, name: '모리커피 청담점', storeType: 'FRANCHISE' },
      employmentType: null,
      joinState: null,
      invitation: null,
      linkHold: null,
      contract: null,
      weeklyScheduledMinutes: null,
      employmentStatus: null,
      retiredDate: null,
    });
  });

  it('가맹관리자(FA)와 직영 점포는 가리지 않는다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'FA',
      stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
    });
    prisma.staffMember.findMany.mockResolvedValue([row({ storeId: 6 })]);
    const res = await service.list(9, {}, NOW);
    expect(res!.items[0].isMasked).toBe(false);
    expect(res!.items[0].name).toBe('서지안');
  });

  it('보류는 끝 4자리와 사유만 낸다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({
        joinStatus: 'INVITED',
        invitations: [
          {
            invitationId: 1,
            invitationType: 'SIGNUP',
            status: 'ACCEPTED',
            sentAt: new Date('2026-08-31T00:12:00Z'),
            expiresAt: new Date('2026-09-30T00:12:00Z'),
            linkHolds: [
              {
                linkHoldId: 7,
                mismatchReason: 'PHONE_MISMATCH',
                createdAt: new Date('2026-08-31T12:40:00Z'),
                account: { phone: '01099994418' },
              },
            ],
          },
        ],
      }),
    ]);
    const item = (await service.list(9, {}, NOW))!.items[0];
    expect(item.joinState).toBe('LINK_HOLD');
    expect(item.linkHold).toEqual({
      linkHoldId: 7,
      mismatchReason: 'PHONE_MISMATCH',
      verifiedPhoneLast4: '4418',
      heldAt: new Date('2026-08-31T12:40:00Z'),
    });
    expect(JSON.stringify(item)).not.toContain('01099994418');
    expect(item.invitation).toEqual({
      invitationType: 'SIGNUP',
      status: 'ACCEPTED',
      lastSentAt: new Date('2026-08-31T00:12:00Z'),
      expiresAt: new Date('2026-09-30T00:12:00Z'),
    });
  });

  it('최근 계약 정렬은 NULL 을 뒤로, 날짜는 YYYY-MM-DD', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        staffMemberId: 30,
        contractId: 4,
        status: 'SIGNED',
        signDeadlineAt: null,
        endDate: new Date('2027-02-28T00:00:00Z'),
      },
    ]);
    const item = (await service.list(9, {}, NOW))!.items[0];
    expect(firstArg(prisma.contract.findMany).orderBy).toEqual([
      { staffMemberId: 'asc' },
      { createdAt: { sort: 'desc', nulls: 'last' } },
      { contractId: 'desc' },
    ]);
    expect(firstArg(prisma.contract.findMany).distinct).toEqual([
      'staffMemberId',
    ]);
    expect(item.contract).toEqual({
      contractId: 4,
      status: 'SIGNED',
      signDeadlineAt: null,
      endDate: '2027-02-28',
    });
  });

  it('이번 주 근무시간은 휴게를 빼고, 삭제분과 다른 주는 쿼리에서 거른다', async () => {
    prisma.workSchedule.findMany.mockResolvedValue([
      {
        staffMemberId: 30,
        startAt: new Date('2026-10-13T00:00:00Z'),
        endAt: new Date('2026-10-13T08:00:00Z'),
        breakMinutes: 60,
      },
      {
        staffMemberId: 30,
        startAt: new Date('2026-10-14T04:00:00Z'),
        endAt: new Date('2026-10-14T08:30:00Z'),
        breakMinutes: 0,
      },
    ]);
    const item = (await service.list(9, {}, NOW))!.items[0];
    expect(item.weeklyScheduledMinutes).toBe(420 + 270);
    expect(firstArg(prisma.workSchedule.findMany).where).toEqual({
      staffMemberId: { in: [30] },
      isDeleted: false,
      startAt: {
        gte: new Date('2026-10-11T15:00:00Z'),
        lt: new Date('2026-10-18T15:00:00Z'),
      },
    });
  });

  it('스케줄 · 계약이 없으면 0분 · null, 퇴직일은 YYYY-MM-DD', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({ retiredDate: new Date('2026-09-30T00:00:00Z') }),
    ]);
    const item = (await service.list(9, {}, NOW))!.items[0];
    expect(item.weeklyScheduledMinutes).toBe(0);
    expect(item.contract).toBeNull();
    expect(item.retiredDate).toBe('2026-09-30');
    expect(item.joinState).toBe('JOINED');
  });

  it('빈 페이지면 덧붙이는 조회를 하지 않는다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([]);
    prisma.staffMember.count.mockResolvedValue(12);
    await expect(service.list(9, { page: 9 }, NOW)).resolves.toEqual({
      items: [],
      total: 12,
    });
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });
});
