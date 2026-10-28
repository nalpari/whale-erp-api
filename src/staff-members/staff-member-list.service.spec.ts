import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { joinStateWhere } from './join-state';
import { StaffMemberListService } from './staff-member-list.service';

const row = (over: object = {}) => ({
  staffMemberId: 30,
  storeId: 5,
  name: '서지안',
  phone: '01028417702',
  employmentType: 'FULL_TIME',
  jobTitle: '바리스타',
  hiredDate: null,
  joinStatus: 'JOINED',
  employmentStatus: 'EMPLOYED',
  retiredDate: null,
  // 본사 제공 동의는 계정에 있다(2026-10-20). 기본은 계정 없음 — 동의하지 않은 것과 같다
  account: null,
  invitations: [],
  // 상세만 읽는 가장 최근 계약 1건(생년월일). Prisma 는 관계 배열을 늘 준다
  contracts: [],
  ...over,
});

describe('StaffMemberListService', () => {
  let service: StaffMemberListService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    staffMember: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
    };
    store: { findMany: jest.Mock };
    contract: { findMany: jest.Mock };
    account: { findMany: jest.Mock };
    workSchedule: { findMany: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
    menu: { count: jest.Mock };
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
      // 재입사 사슬 조회(linkedRecords) — 기본은 이은 레코드가 없다. 재직 이력은 e2e 가 실제 DB 로 본다
      $queryRaw: jest.fn().mockResolvedValue([]),
      staffMember: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findFirst: jest.fn().mockResolvedValue(row()),
        count: jest.fn().mockResolvedValue(1),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 5, name: '모리커피 서초점', storeTypeCode: 'DIRECT' },
          { storeId: 6, name: '모리커피 청담점', storeTypeCode: 'FRANCHISE' },
        ]),
      },
      contract: { findMany: jest.fn().mockResolvedValue([]) },
      // 재발송 판정의 「그 번호에 계정이 있는가」 — 기본은 없다
      account: { findMany: jest.fn().mockResolvedValue([]) },
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      // 근로계약 관리 메뉴 조회 권한(adminHasMenuAction, 재영 2026-10-27) — 기본은 있다. 상세의 이메일은 직원 정보 관리
      // 권한을 묻지 않는다(WHALEERP-180)
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 1 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
      // 권한이 없을 때 메뉴 자체가 있는지 보는 로그 경로(reportMissingMenu)
      menu: { count: jest.fn().mockResolvedValue(1) },
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
    await expect(service.list(9, {})).resolves.toBeNull();
    expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
  });

  it('관리 범위와 storeIds 의 교집합이 비면 쿼리 없이 빈 목록', async () => {
    await expect(service.list(9, { storeIds: [99] })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
  });

  it('범위 밖 storeIds 는 조용히 빠진다', async () => {
    await service.list(9, { storeIds: [5, 99] });
    expect(where().AND).toContainEqual({ storeId: { in: [5] } });
  });

  describe('점포 유형(storeTypes) — 상단 점포 범위 직영 · 가맹(2026-10-22 재영)', () => {
    /** 폐점을 빼려고 묻는 점포 조회 — toItems 의 점포 조회(name 을 읽는다)와 select 로 가른다 */
    const openStoreCalls = () =>
      (prisma.store.findMany.mock.calls as [Record<string, object>][])
        .map(([arg]) => arg)
        .filter((arg) => !('name' in arg.select));

    beforeEach(() => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 5, storeTypeCode: 'DIRECT' },
          { storeId: 6, storeTypeCode: 'FRANCHISE' },
          { storeId: 7, storeTypeCode: 'DIRECT' },
        ],
      });
    });

    it('직영만 — 그 유형 점포 중 폐점이 아닌 것만 묻고 거른다', async () => {
      // 7 은 폐점이라 조회에서 빠진다
      prisma.store.findMany.mockResolvedValueOnce([{ storeId: 5 }]);
      await service.list(9, { storeTypes: ['DIRECT'] });
      expect(openStoreCalls()[0]).toEqual({
        where: { storeId: { in: [5, 7] }, storeStatusCode: { not: 'CLOSED' } },
        select: { storeId: true },
      });
      expect(where().AND).toContainEqual({ storeId: { in: [5] } });
    });

    it('가맹만 · 둘 다', async () => {
      prisma.store.findMany.mockResolvedValueOnce([{ storeId: 6 }]);
      await service.list(9, { storeTypes: ['FRANCHISE'] });
      expect(openStoreCalls()[0].where).toEqual({
        storeId: { in: [6] },
        storeStatusCode: { not: 'CLOSED' },
      });
      expect(where().AND).toContainEqual({ storeId: { in: [6] } });

      prisma.store.findMany.mockClear();
      prisma.staffMember.findMany.mockClear();
      prisma.store.findMany.mockResolvedValueOnce([
        { storeId: 5 },
        { storeId: 6 },
      ]);
      await service.list(9, { storeTypes: ['DIRECT', 'FRANCHISE'] });
      expect(openStoreCalls()[0].where).toEqual({
        storeId: { in: [5, 6, 7] },
        storeStatusCode: { not: 'CLOSED' },
      });
      expect(where().AND).toContainEqual({ storeId: { in: [5, 6] } });
    });

    it('storeIds 와 함께 주면 둘 다 맞는 점포만(교집합), 범위 밖 id 는 빠진다', async () => {
      prisma.store.findMany.mockResolvedValueOnce([{ storeId: 7 }]);
      await service.list(9, { storeIds: [6, 7, 99], storeTypes: ['DIRECT'] });
      expect(openStoreCalls()[0].where).toEqual({
        storeId: { in: [7] },
        storeStatusCode: { not: 'CLOSED' },
      });
      expect(where().AND).toContainEqual({ storeId: { in: [7] } });
    });

    it('겹치는 점포가 없으면 점포도 직원도 묻지 않고 0건', async () => {
      await expect(
        service.list(9, { storeIds: [6], storeTypes: ['DIRECT'] }),
      ).resolves.toEqual({ items: [], total: 0 });
      expect(prisma.store.findMany).not.toHaveBeenCalled();
      expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
    });

    it('남은 점포가 모두 폐점이면 직원을 묻지 않고 0건', async () => {
      prisma.store.findMany.mockResolvedValueOnce([]);
      await expect(
        service.list(9, { storeTypes: ['DIRECT'] }),
      ).resolves.toEqual({ items: [], total: 0 });
      expect(prisma.staffMember.findMany).not.toHaveBeenCalled();
    });

    it('점포 유형을 주지 않으면 폐점을 묻지 않는다 — 유형 · 폐점 무관', async () => {
      await service.list(9, { storeIds: [5, 7] });
      expect(openStoreCalls()).toEqual([]);
      expect(where().AND).toContainEqual({ storeId: { in: [5, 7] } });
    });

    it('개인 칸으로 거를 때 가림 갈래도 남은 점포로만 나뉜다', async () => {
      prisma.store.findMany.mockResolvedValueOnce([{ storeId: 6 }]);
      await service.list(9, { storeTypes: ['FRANCHISE'], keyword: '홍길동' });
      expect(where().AND).toContainEqual({
        OR: [
          { storeId: { in: [] } },
          {
            storeId: { in: [6] },
            account: { is: { isHqSharingConsented: true } },
          },
        ],
      });
    });
  });

  it('페이지 · 정렬 · count 가 같은 where 를 쓴다', async () => {
    await service.list(9, { page: 3, pageSize: 10 });
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
    await service.list(9, { keyword: '010-2841' });
    expect(where().AND).toContainEqual({
      OR: [
        { name: { contains: '010-2841', mode: 'insensitive' } },
        { phone: { contains: '0102841' } },
      ],
    });
  });

  it('필터가 있으면 BM · BA 에게 가맹 점포의 동의 안 한 직원을 뺀다 — 가린 행이 검색으로 드러나지 않게', async () => {
    await service.list(9, { keyword: '홍길동' });
    expect(where().AND).toContainEqual({
      OR: [
        { storeId: { in: [5] } },
        {
          storeId: { in: [6] },
          account: { is: { isHqSharingConsented: true } },
        },
      ],
    });
  });

  it('재직 상태 필터만으로는 BM · BA 에게 가맹 점포를 빼지 않는다', async () => {
    await service.list(9, { employmentStatus: 'EMPLOYED' });
    expect(where().AND).toContainEqual({ storeId: { in: [5, 6] } });
  });

  it('joinState 는 여러 값을 받아 OR 로 거른다 — 화면의 묶음 체크', async () => {
    await service.list(9, { joinState: ['INVITED', 'EXPIRED'] });
    expect(where().AND).toContainEqual({
      OR: [joinStateWhere('INVITED'), joinStateWhere('EXPIRED')],
    });
  });

  it('employmentType 은 여러 값을 in 으로 거른다', async () => {
    await service.list(9, { employmentType: ['PART_TIME'] });
    expect(where().AND).toContainEqual({
      employmentType: { in: ['PART_TIME'] },
    });
  });

  it.each([
    ['BM', { keyword: '홍길동' }],
    ['BA', { keyword: '홍길동' }],
    ['BM', { joinState: ['JOINED'] }],
    ['BA', { joinState: ['JOINED'] }],
    ['BM', { employmentType: ['PART_TIME'] }],
    ['BA', { employmentType: ['PART_TIME'] }],
  ] as const)(
    '%s 가 개인 칸 %j 로 거르면 가맹 점포는 본사 제공 동의한 직원만 남긴다',
    async (roleTypeCode, query) => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode,
        stores: [
          { storeId: 5, storeTypeCode: 'DIRECT' },
          { storeId: 6, storeTypeCode: 'FRANCHISE' },
        ],
      });
      await service.list(9, { ...query } as never);
      expect(where().AND).toContainEqual({
        OR: [
          { storeId: { in: [5] } },
          {
            storeId: { in: [6] },
            account: { is: { isHqSharingConsented: true } },
          },
        ],
      });
    },
  );

  it.each(['BM', 'BA'])(
    '%s 에게 가맹 점포 줄은 가린다',
    async (roleTypeCode) => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode,
        stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
      });
      prisma.staffMember.findMany.mockResolvedValue([row({ storeId: 6 })]);
      const item = (await service.list(9, {}))!.items[0];
      expect(item.isMasked).toBe(true);
      expect(item.name).toBeNull();
      // ID 를 주면 직원 단위 API 로 가린 직원을 찾아갈 수 있다.
      expect(item.staffMemberId).toBeNull();
    },
  );

  it.each(['BM', 'BA'])(
    '%s 에게도 본사 제공 동의한 가맹 점포 직원은 가리지 않는다(ATT-30)',
    async (roleTypeCode) => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode,
        stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
      });
      prisma.staffMember.findMany.mockResolvedValue([
        row({ storeId: 6, account: { isHqSharingConsented: true } }),
      ]);
      const item = (await service.list(9, {}))!.items[0];
      expect(item.isMasked).toBe(false);
      expect(item.staffMemberId).toBe(30);
      expect(item.name).toBe('서지안');
      expect(item.phone).toBe('01028417702');
      expect(firstArg(prisma.staffMember.findMany).select).toMatchObject({
        account: { select: { isHqSharingConsented: true } },
      });
    },
  );

  it('고른 점포가 모두 가맹이면 개인 칸으로 거를 때 동의한 직원만 남는다 — 첫 갈래는 빈 목록', async () => {
    await service.list(9, { storeIds: [6], keyword: '홍길동' });
    expect(where().AND).toContainEqual({
      OR: [
        { storeId: { in: [] } },
        {
          storeId: { in: [6] },
          account: { is: { isHqSharingConsented: true } },
        },
      ],
    });
  });

  it('가릴 점포가 없으면 개인 칸으로 걸러도 점포 조건 그대로다', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'BM',
      stores: [{ storeId: 5, storeTypeCode: 'DIRECT' }],
    });
    await service.list(9, { keyword: '서지안' });
    expect(where().AND).toContainEqual({ storeId: { in: [5] } });
  });

  it('점포 정보를 못 찾으면 오류다 — 빈 칸이나 가리지 않은 줄로 내보내지 않는다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([row({ storeId: 6 })]);
    prisma.store.findMany.mockResolvedValue([]);
    await expect(service.list(9, {})).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('이미 수락한 초대는 다시 보내지 않는다 — 받은 링크로 다시 들어온다(2026-10-12 yjnoh)', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({
        joinStatus: 'INVITED',
        invitations: [
          {
            invitationId: 1,
            invitationType: 'SIGNUP',
            status: 'ACCEPTED',
            sentAt: new Date('2026-10-01T00:00:00Z'),
            expiresAt: new Date('2026-10-31T00:00:00Z'),
            linkHolds: [],
          },
        ],
      }),
    ]);
    const item = (await service.list(9, {}))!.items[0];
    expect(item.joinState).toBe('INVITED');
    expect(item.invitation?.canResend).toBe(false);
  });

  it('필터가 없으면 BM · BA 도 가맹 점포를 포함하고 그 줄을 가린다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({ staffMemberId: 31, storeId: 6, name: '가맹직원' }),
    ]);
    const res = await service.list(9, {});
    expect(where().AND).toContainEqual({ storeId: { in: [5, 6] } });
    expect(res!.items[0]).toEqual({
      staffMemberId: null,
      isMasked: true,
      name: null,
      phone: null,
      store: { storeId: 6, name: '모리커피 청담점', storeType: 'FRANCHISE' },
      employmentType: null,
      joinState: null,
      invitation: null,
      linkHold: null,
      contract: null,
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
    const res = await service.list(9, {});
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
    const item = (await service.list(9, {}))!.items[0];
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
      canResend: false, // 보류는 「연결 확인」에서 처리한다
    });
  });

  describe('contract.canResend — 재발송 api(POST /contracts/:id/send)가 실제로 보낼 수 있을 때만(WHALEERP-611 · api #164)', () => {
    const invited = (
      invitationType = 'SIGNUP',
      status = 'SENT',
      over: object = {},
    ) =>
      row({
        joinStatus: 'INVITED',
        invitations: [
          {
            invitationId: 1,
            invitationType,
            status,
            sentAt: new Date('2026-10-01T00:00:00Z'),
            expiresAt: new Date('2026-10-31T00:00:00Z'),
            linkHolds: [],
          },
        ],
        ...over,
      });
    const contract = (
      status: string | null,
      draftAction: string | null = 'SIGNUP_INVITE',
    ) => ({
      staffMemberId: 30,
      contractId: 4,
      status,
      signDeadlineAt: null,
      endDate: null,
      updatedAt: null,
      draftAction,
      contractWorkDays: [],
    });
    const canResendOf = async (
      staff: object,
      contractStatus: string | null = 'PENDING_SEND',
    ) => {
      prisma.staffMember.findMany.mockResolvedValue([staff]);
      prisma.contract.findMany.mockResolvedValue(
        contractStatus === null ? [] : [contract(contractStatus)],
      );
      // 계약이 없는 줄(가린 줄 포함)은 contract 가 null 이라 버튼이 없다 — false 로 본다
      return (await service.list(9, {}))!.items[0].contract?.canResend ?? false;
    };

    it.each([
      ['SIGNUP', 'SENT', 'PENDING_SEND', true],
      ['SIGNUP', 'SENT', 'PENDING_SIGNATURE', true],
      ['SIGNUP', 'EXPIRED', 'PENDING_SEND', true],
      ['REINVITE', 'SENT', 'PENDING_SEND', true],
      ['SIGNUP', 'SENT', 'DRAFT', false],
      ['SIGNUP', 'SENT', 'CORRECTION_REQUESTED', false],
      // 거부 · 만료 재발송(WHALEERP-153)은 되살릴 수 있는지까지 봐야 해 근로계약 상세에서 한다
      ['SIGNUP', 'EXPIRED', 'EXPIRED', false],
      ['SIGNUP', 'SENT', 'REJECTED', false],
      ['SIGNUP', 'SENT', 'ENDED', false],
      ['SIGNUP', 'SENT', 'SIGNED', false],
      ['AFFILIATION_CONFIRM', 'REJECTED', 'PENDING_SEND', false],
      ['SIGNUP', 'REJECTED_UNDER_AGE', 'PENDING_SEND', false],
    ])(
      '계정 없는 번호 — %s %s · 계약 %s → %s',
      async (invitationType, status, contractStatus, expected) => {
        expect(
          await canResendOf(invited(invitationType, status), contractStatus),
        ).toBe(expected);
      },
    );

    it('최근 계약이 없으면 보낼 계약이 없어 false', async () => {
      expect(await canResendOf(invited(), null)).toBe(false);
    });

    it.each([
      ['PENDING_SIGNATURE', 'AFFILIATION_CONFIRM', true],
      ['PENDING_SIGNATURE', 'RETURN_CONFIRM', true],
      ['PENDING_SEND', 'AFFILIATION_CONFIRM', true],
      ['DRAFT', 'AFFILIATION_CONFIRM', false],
      ['SIGNED', 'AFFILIATION_CONFIRM', false],
      // 노린 대상(옛 소속 확인 계약)이 아닌 초대 없는 줄은 거짓이다
      ['PENDING_SIGNATURE', 'SIGNUP_INVITE', false],
      ['PENDING_SIGNATURE', 'IMMEDIATE_SEND', false],
      ['PENDING_SIGNATURE', null, false],
    ])(
      '초대 행이 없는 가입 전 직원 — 계약 %s · 판별 %s → contract.canResend %s, invitation 은 null(api #164 리뷰)',
      async (status, draftAction, expected) => {
        prisma.staffMember.findMany.mockResolvedValue([
          row({ joinStatus: 'DRAFT', invitations: [] }),
        ]);
        prisma.contract.findMany.mockResolvedValue([
          contract(status, draftAction),
        ]);
        const [item] = (await service.list(9, {}))!.items;
        expect(item.joinState).toBe('DRAFT');
        expect(item.invitation).toBeNull();
        expect(item.contract?.canResend).toBe(expected);
      },
    );

    it('앞 초대를 수락했어도 뒤에 나간 재초대(연결 보류 → 번호 수정 후 재초대)가 보이는 초대면 다시 보낼 수 있다 — 보이는 초대를 수락했으면 거짓', async () => {
      const chain = (last: string) =>
        row({
          joinStatus: 'INVITED',
          invitations: [
            {
              invitationId: 1,
              invitationType: 'SIGNUP',
              status: 'ACCEPTED',
              sentAt: new Date('2026-09-01T00:00:00Z'),
              expiresAt: new Date('2026-10-01T00:00:00Z'),
              linkHolds: [],
            },
            {
              invitationId: 2,
              invitationType: 'REINVITE',
              status: last,
              sentAt: new Date('2026-09-10T00:00:00Z'),
              expiresAt: new Date('2026-10-10T00:00:00Z'),
              linkHolds: [],
            },
          ],
        });
      expect(await canResendOf(chain('EXPIRED'))).toBe(true);
      expect(await canResendOf(invited('SIGNUP', 'ACCEPTED'))).toBe(false);
    });

    it('contract.canResend 와 invitation.canResend 는 같은 값이다(invitation 쪽은 옮겨 가는 동안만)', async () => {
      prisma.staffMember.findMany.mockResolvedValue([invited()]);
      prisma.contract.findMany.mockResolvedValue([contract('PENDING_SEND')]);
      const [item] = (await service.list(9, {}))!.items;
      expect(item.contract?.canResend).toBe(true);
      expect(item.invitation?.canResend).toBe(true);
    });

    it.each([['AFFILIATION_CONFIRM'], ['RETURN_CONFIRM'], ['SIGNUP']])(
      '그 번호에 계정이 있어도 %s 초대면 true — 재발송이 소속 추가 확인 요청을 다시 보낸다(WHALEERP-130, 2026-10-26 재영)',
      async (invitationType) => {
        prisma.account.findMany.mockResolvedValue([{ phone: '01028417702' }]);
        expect(
          await canResendOf(invited(invitationType), 'PENDING_SIGNATURE'),
        ).toBe(true);
        // 계정이 있는지 묻지 않는다 — 받을 길(가입 초대 · 소속 추가 확인 요청)은 재발송이 판별한다
        expect(prisma.account.findMany).not.toHaveBeenCalled();
      },
    );

    it('소속 확인 초대여도 그 번호의 계정이 탈퇴해 없으면 가입 초대로 보내므로 true', async () => {
      expect(
        await canResendOf(invited('AFFILIATION_CONFIRM'), 'PENDING_SIGNATURE'),
      ).toBe(true);
    });

    it('가린 줄뿐이면 계정을 찾지 않는다', async () => {
      await canResendOf(invited('SIGNUP', 'SENT', { storeId: 6 }));
      expect(prisma.account.findMany).not.toHaveBeenCalled();
    });

    it('물을 줄이 없으면 계정을 찾지 않는다', async () => {
      await canResendOf(row());
      expect(prisma.account.findMany).not.toHaveBeenCalled();
    });

    it('휴대폰 번호가 아니면 알림톡을 보낼 수 없어 false(api 409 SEND_PHONE_NOT_MOBILE)', async () => {
      expect(
        await canResendOf(invited('SIGNUP', 'SENT', { phone: '0212345678' })),
      ).toBe(false);
    });

    it('가입한 직원은 목록에서 다시 보내지 않는다 — 앱 알림 재발송은 근로계약 상세에서(가입 초대가 아니다)', async () => {
      const joined = row({
        joinStatus: 'JOINED',
        invitations: invited('SIGNUP', 'ACCEPTED').invitations,
      });
      expect(await canResendOf(joined, 'PENDING_SIGNATURE')).toBe(false);
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
        updatedAt: new Date('2026-09-02T05:00:00Z'),
        contractWorkDays: [],
      },
    ]);
    const item = (await service.list(9, {}))!.items[0];
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
      // 거부일은 따로 저장하지 않고 최종 수정 일시로 보인다(2026-10-12 재영).
      updatedAt: new Date('2026-09-02T05:00:00Z'),
      canResend: false,
      workDays: [],
    });
  });

  it('workDays — 근무 요일을 HH:mm 으로, 휴게 없으면 null, 요일 없으면 빈 배열(WHALEERP-622)', async () => {
    const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
    const base = {
      signDeadlineAt: null,
      endDate: null,
      updatedAt: null,
      status: 'SIGNED',
    };
    prisma.staffMember.findMany.mockResolvedValue([
      row(),
      row({ staffMemberId: 31 }),
    ]);
    prisma.contract.findMany.mockResolvedValue([
      {
        ...base,
        staffMemberId: 30,
        contractId: 4,
        contractWorkDays: [
          {
            weekday: 'MON',
            startTime: t('09:00'),
            endTime: t('18:00'),
            breakStartTime: t('12:00'),
            breakEndTime: t('13:00'),
          },
          {
            weekday: 'TUE',
            startTime: t('10:30'),
            endTime: t('15:00'),
            breakStartTime: null,
            breakEndTime: null,
          },
        ],
      },
      { ...base, staffMemberId: 31, contractId: 5, contractWorkDays: [] },
    ]);
    const items = (await service.list(9, {}))!.items;
    expect(firstArg(prisma.contract.findMany).select).toMatchObject({
      contractWorkDays: { orderBy: { weekday: 'asc' } },
    });
    expect(items[0].contract?.workDays).toEqual([
      {
        weekday: 'MON',
        startTime: '09:00',
        endTime: '18:00',
        breakStartTime: '12:00',
        breakEndTime: '13:00',
      },
      {
        weekday: 'TUE',
        startTime: '10:30',
        endTime: '15:00',
        breakStartTime: null,
        breakEndTime: null,
      },
    ]);
    expect(items[1].contract?.workDays).toEqual([]);
  });

  describe('workDays 는 근로계약 조회 권한을 따른다(재영 결정 2026-10-27)', () => {
    const contractRow = {
      staffMemberId: 30,
      contractId: 4,
      status: 'SIGNED',
      signDeadlineAt: null,
      endDate: null,
      updatedAt: null,
    };
    const noRead = () => prisma.roleGroupMenu.count.mockResolvedValue(0);

    it('권한이 있으면 /contracts 메뉴의 read 를 한 번 묻고 줄마다 묻지 않는다', async () => {
      prisma.staffMember.findMany.mockResolvedValue([
        row(),
        row({ staffMemberId: 31 }),
      ]);
      prisma.contract.findMany.mockResolvedValue([
        { ...contractRow, contractWorkDays: [] },
      ]);
      await service.list(9, {});
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledTimes(1);
    });

    it('권한이 없으면 /contracts 메뉴가 있는지 확인한다 — 없으면 로그(홈의 canRead 와 같다)', async () => {
      noRead();
      prisma.contract.findMany.mockResolvedValue([contractRow]);
      await service.list(9, {});
      expect(prisma.menu.count).toHaveBeenCalledTimes(1);
      expect((firstArg(prisma.menu.count).where as { url: string }).url).toBe(
        '/contracts',
      );
    });

    it('목록 — 권한이 없으면 workDays 는 null 이고 근무 요일을 읽지 않는다', async () => {
      noRead();
      prisma.contract.findMany.mockResolvedValue([contractRow]);
      const items = (await service.list(9, {}))!.items;
      expect(items[0].contract?.workDays).toBeNull();
      expect(items[0].contract?.contractId).toBe(4);
      expect(firstArg(prisma.contract.findMany).select).not.toHaveProperty(
        'contractWorkDays',
      );
    });

    it('목록 — 사용 중이 아닌 관리자(권한 판정 false)도 근무 요일을 읽지 않는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      prisma.contract.findMany.mockResolvedValue([contractRow]);
      const items = (await service.list(9, {}))!.items;
      expect(items[0].contract?.workDays).toBeNull();
      expect(firstArg(prisma.contract.findMany).select).not.toHaveProperty(
        'contractWorkDays',
      );
    });

    it('상세 — 권한이 없으면 workDays 는 null 이고 근무 요일을 읽지 않는다', async () => {
      noRead();
      prisma.contract.findMany.mockResolvedValue([contractRow]);
      const detail = await service.findOne(9, 30);
      expect(detail!.contract?.workDays).toBeNull();
      expect(firstArg(prisma.contract.findMany).select).not.toHaveProperty(
        'contractWorkDays',
      );
    });

    it('상세 — 권한이 있으면 select 에 근무 요일이 붙는다', async () => {
      prisma.contract.findMany.mockResolvedValue([
        { ...contractRow, contractWorkDays: [] },
      ]);
      const detail = await service.findOne(9, 30);
      expect(detail!.contract?.workDays).toEqual([]);
      expect(firstArg(prisma.contract.findMany).select).toHaveProperty(
        'contractWorkDays',
      );
    });
  });

  it('근무스케줄은 읽지 않고 응답에 근무시간 칸이 없다 — 목록 화면에서 이번 주 칸을 뺐다', async () => {
    const item = (await service.list(9, {}))!.items[0];
    expect(item).not.toHaveProperty('weeklyScheduledMinutes');
    expect(prisma.workSchedule.findMany).not.toHaveBeenCalled();
  });

  it('계약이 없으면 null, 퇴직일은 YYYY-MM-DD', async () => {
    prisma.staffMember.findMany.mockResolvedValue([
      row({ retiredDate: new Date('2026-09-30T00:00:00Z') }),
    ]);
    const item = (await service.list(9, {}))!.items[0];
    expect(item.contract).toBeNull();
    expect(item.retiredDate).toBe('2026-09-30');
    expect(item.joinState).toBe('JOINED');
  });

  it('빈 페이지면 덧붙이는 조회를 하지 않는다', async () => {
    prisma.staffMember.findMany.mockResolvedValue([]);
    prisma.staffMember.count.mockResolvedValue(12);
    await expect(service.list(9, { page: 9 })).resolves.toEqual({
      items: [],
      total: 12,
    });
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });
  describe('findOne — 직원 상세(WHALEERP-599)', () => {
    it('목록 한 줄과 같은 값에 계정 이메일 칸을 더해 낸다', async () => {
      const listed = (await service.list(9, {}))!.items[0];
      await expect(service.findOne(9, 30)).resolves.toEqual({
        ...listed,
        email: null,
        jobTitle: '바리스타',
        hiredDate: null,
        birthDate: null,
        birthDateCorrectable: false,
        hqSharingConsent: null,
        // 이은 레코드가 없다(WHALEERP-615)
        previousRecords: [],
        laterRecords: [],
      });
    });

    it('대표 계약의 workDays 를 목록과 같이 HH:mm 으로 싣는다(WHALEERP-622)', async () => {
      prisma.contract.findMany.mockResolvedValue([
        {
          staffMemberId: 30,
          contractId: 4,
          status: 'SIGNED',
          signDeadlineAt: null,
          endDate: null,
          updatedAt: null,
          contractWorkDays: [
            {
              weekday: 'MON',
              startTime: new Date('1970-01-01T09:00:00Z'),
              endTime: new Date('1970-01-01T18:00:00Z'),
              breakStartTime: new Date('1970-01-01T12:00:00Z'),
              breakEndTime: new Date('1970-01-01T13:00:00Z'),
            },
          ],
        },
      ]);
      const detail = await service.findOne(9, 30);
      expect(detail!.contract?.workDays).toEqual([
        {
          weekday: 'MON',
          startTime: '09:00',
          endTime: '18:00',
          breakStartTime: '12:00',
          breakEndTime: '13:00',
        },
      ]);
    });

    describe('birthDateCorrectable (WHALEERP-602)', () => {
      // now 는 한국 2026-10-26
      const now = new Date('2026-10-26T03:00:00Z');
      const correctable = async (over: object) => {
        prisma.staffMember.findFirst.mockResolvedValue(row(over));
        return (await service.findOne(9, 30, now))!.birthDateCorrectable;
      };
      const joined = { email: 'a@test.invalid', status: 'JOINED' };

      it('가입 완료 계정의 재직 직원은 true — 퇴직 예정(퇴직일 오늘 · 이후)도 true', async () => {
        expect(await correctable({ account: joined })).toBe(true);
        expect(
          await correctable({
            account: joined,
            retiredDate: new Date('2026-10-26T00:00:00Z'),
          }),
        ).toBe(true);
      });

      it.each([
        ['탈퇴 계정', { account: { ...joined, status: 'WITHDRAWN' } }],
        ['연결 보류 계정', { account: { ...joined, status: 'LINK_HOLD' } }],
        ['계정 없음(가입 전)', { account: null }],
        ['퇴직', { account: joined, employmentStatus: 'RETIRED' }],
        [
          '퇴직일이 지났는데 배치 전',
          { account: joined, retiredDate: new Date('2026-10-25T00:00:00Z') },
        ],
      ])('%s 는 false — 정정 API 가 409 로 막는 경우', async (_name, over) => {
        expect(await correctable(over)).toBe(false);
      });

      it('목록 줄에는 싣지 않는다', async () => {
        const [listed] = (await service.list(9, {}))!.items;
        expect(listed).not.toHaveProperty('birthDateCorrectable');
      });
    });

    describe('본사 제공 동의 상태(WHALEERP-184 완료 조건 8)', () => {
      const fa = () =>
        scope.getManageableStores.mockResolvedValue({
          roleTypeCode: 'FA',
          stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
        });

      it('직영 점포 직원은 null — 동의가 판단에 쓰이지 않는다', async () => {
        prisma.staffMember.findFirst.mockResolvedValue(
          row({
            account: {
              email: 'd@test.invalid',
              status: 'JOINED',
              isHqSharingConsented: true,
            },
          }),
        );
        await expect(service.findOne(9, 30)).resolves.toMatchObject({
          hqSharingConsent: null,
        });
      });

      it('가맹 점포 직원이 동의했으면 AGREED — 본사 역할이 연 상세', async () => {
        prisma.staffMember.findFirst.mockResolvedValue(
          row({
            storeId: 6,
            account: {
              email: 'fc@test.invalid',
              status: 'JOINED',
              isHqSharingConsented: true,
            },
          }),
        );
        await expect(service.findOne(9, 30)).resolves.toMatchObject({
          hqSharingConsent: 'AGREED',
        });
      });

      it('가맹 점포 직원이 동의하지 않았거나 철회했으면 NOT_AGREED — 가맹 역할이 연 상세', async () => {
        fa();
        prisma.staffMember.findFirst.mockResolvedValue(
          row({
            storeId: 6,
            account: {
              email: 'fc@test.invalid',
              status: 'JOINED',
              isHqSharingConsented: false,
            },
          }),
        );
        await expect(service.findOne(9, 30)).resolves.toMatchObject({
          hqSharingConsent: 'NOT_AGREED',
        });
      });

      it('가입 전(계정 없음) 가맹 점포 직원은 NOT_AGREED — 가림 판정과 같이 동의하지 않은 것으로 본다', async () => {
        fa();
        prisma.staffMember.findFirst.mockResolvedValue(
          row({ storeId: 6, account: null }),
        );
        await expect(service.findOne(9, 30)).resolves.toMatchObject({
          hqSharingConsent: 'NOT_AGREED',
        });
      });
    });

    describe('기본 정보 칸(WHALEERP-183) — 직무 · 입사일 · 생년월일', () => {
      const date = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

      it('직무 · 입사일은 직원 레코드 값이다 — 입사일은 YYYY-MM-DD', async () => {
        prisma.staffMember.findFirst.mockResolvedValue(
          row({ jobTitle: '바리스타', hiredDate: date('2026-03-01') }),
        );
        await expect(service.findOne(9, 30)).resolves.toMatchObject({
          jobTitle: '바리스타',
          hiredDate: '2026-03-01',
        });
      });

      it('생년월일은 가입한 계정 값이다 — 계약서에 관리자가 적은 값보다 먼저', async () => {
        prisma.staffMember.findFirst.mockResolvedValue(
          row({
            account: {
              email: 'jian@test.invalid',
              status: 'JOINED',
              birthDate: date('1998-07-12'),
            },
            contracts: [
              { contractParty: { enteredBirthDate: date('1998-07-11') } },
            ],
          }),
        );
        await expect(service.findOne(9, 30)).resolves.toMatchObject({
          birthDate: '1998-07-12',
        });
      });

      it.each([
        ['가입 전(계정 없음)', null],
        [
          '탈퇴 계정',
          {
            email: 'gone@test.invalid',
            status: 'WITHDRAWN',
            birthDate: date('1990-01-01'),
          },
        ],
      ])(
        '%s 이면 가장 최근 계약에 관리자가 적은 생년월일',
        async (_, account) => {
          prisma.staffMember.findFirst.mockResolvedValue(
            row({
              account,
              contracts: [
                { contractParty: { enteredBirthDate: date('1998-07-11') } },
              ],
            }),
          );
          await expect(service.findOne(9, 30)).resolves.toMatchObject({
            birthDate: '1998-07-11',
          });
        },
      );

      it('계정도 계약 당사자 값도 없으면 null', async () => {
        prisma.staffMember.findFirst.mockResolvedValue(
          row({ contracts: [{ contractParty: null }] }),
        );
        await expect(service.findOne(9, 30)).resolves.toMatchObject({
          birthDate: null,
        });
      });

      // 새 계약을 생년월일 없이 임시저장해도 예전 계약에 적은 값이 보이게 — 최근 계약이 아니라 생년월일이 적힌 최근 계약이다(api #113 리뷰)
      it('생년월일이 적힌 가장 최근 계약 하나의 당사자만 읽는다 — 목록 · 상세의 contract 와 같은 정렬', async () => {
        await service.findOne(9, 30);
        const select = firstArg(prisma.staffMember.findFirst).select as Record<
          string,
          unknown
        >;
        expect(select).toMatchObject({
          jobTitle: true,
          hiredDate: true,
          account: { select: { birthDate: true } },
          contracts: {
            where: { contractParty: { enteredBirthDate: { not: null } } },
            orderBy: [
              { createdAt: { sort: 'desc', nulls: 'last' } },
              { contractId: 'desc' },
            ],
            take: 1,
            select: { contractParty: { select: { enteredBirthDate: true } } },
          },
        });
      });

      it('목록은 이 칸들을 읽지도 내지도 않는다', async () => {
        const listed = (await service.list(9, {}))!.items[0];
        for (const key of ['jobTitle', 'hiredDate', 'birthDate'])
          expect(listed).not.toHaveProperty(key);
        const select = firstArg(prisma.staffMember.findMany).select as Record<
          string,
          unknown
        >;
        expect(select).not.toHaveProperty('contracts');
        expect(select).not.toHaveProperty('hiredDate');
      });
    });

    // 비밀번호 초기화 확인창이 「재설정 링크가 이메일 아이디 OOO 으로 발송됩니다」에 쓴다(WHALEERP-177). 발송이
    // 쓰는 것과 같은 계정 이메일이다.
    it('가입한 계정이 있으면 그 계정 이메일을 낸다', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(
        row({ account: { email: 'jian@test.invalid', status: 'JOINED' } }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        email: 'jian@test.invalid',
      });
    });

    it('가입 전(계정 없음)이면 이메일은 null', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(row({ account: null }));
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        email: null,
      });
    });

    it('탈퇴한 계정이면 이메일은 null', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(
        row({ account: { email: 'gone@test.invalid', status: 'WITHDRAWN' } }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        email: null,
      });
    });

    // 발송(password-reset-link.service issue)도 탈퇴만 409 라 연결 보류 계정에는 링크가 간다. 확인창의 주소가
    // 실제로 메일이 가는 주소와 같아야 하므로, 조건을 「가입 완료만」으로 좁히면 이 테스트가 실패한다.
    it('연결 보류(LINK_HOLD) 계정이어도 이메일을 낸다 — 발송이 가는 주소와 같게', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(
        row({ account: { email: 'hold@test.invalid', status: 'LINK_HOLD' } }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        email: 'hold@test.invalid',
      });
    });

    // 동의는 자료를 보는 데 대한 것이라 계정 조치로 넓히지 않는다(2026-10-14 재영, ATT-30). 본사 역할은 동의한 가맹
    // 점포 직원의 상세는 열지만 계정 정보인 이메일은 받지 않는다 — 재설정 링크(canManageStaffAccount 404)와 같은 범위다.
    it('본사 역할(BM)에게 동의한 가맹 점포 직원은 상세를 열어도 이메일은 null — 동의는 계정 정보로 넓히지 않는다', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(
        row({
          storeId: 6,
          account: {
            email: 'fc@test.invalid',
            status: 'JOINED',
            isHqSharingConsented: true,
          },
        }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        staffMemberId: 30,
        isMasked: false,
        email: null,
      });
    });

    it('가맹관리자(FA)에게는 자기 가맹 점포 직원의 이메일을 낸다', async () => {
      scope.getManageableStores.mockResolvedValue({
        roleTypeCode: 'FA',
        stores: [{ storeId: 6, storeTypeCode: 'FRANCHISE' }],
      });
      prisma.staffMember.findFirst.mockResolvedValue(
        row({
          storeId: 6,
          account: { email: 'fc@test.invalid', status: 'JOINED' },
        }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        email: 'fc@test.invalid',
      });
    });

    // 이메일은 회원 ID 다. 직원이 근무지에 직접 와서 물으면 마주한 관리자가 알려 주는데, 그 관리자는 조회만 켠 그룹일
    // 수 있다 — 상세를 열 수 있으면 수정 권한과 상관없이 낸다(WHALEERP-180, ACC-16 · 17, 2026-10-16 영주).
    it('직원 정보 관리 수정 권한이 없어도 상세를 열 수 있으면 이메일을 낸다 — 직원 정보 관리 권한 그룹은 묻지 않는다', async () => {
      // 권한 없음. 이메일에 권한 조건이 생기면 값이 null 이 되어 실패한다. 묻는 것은 근로계약 조회 권한(workDays) 하나뿐이다.
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      prisma.staffMember.findFirst.mockResolvedValue(
        row({ account: { email: 'jian@test.invalid', status: 'JOINED' } }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        staffMemberId: 30,
        email: 'jian@test.invalid',
      });
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledTimes(1);
      const arg = firstArg(prisma.roleGroupMenu.count) as {
        where: { menu: { url: string } };
      };
      expect(arg.where.menu.url).toBe('/contracts');
    });

    // 퇴직 레코드는 계정이 살아 있어도 전 근무지 관리자에게 회원 ID 를 계속 보이지 않는다(2026-10-16 영주). 발송도
    // 409 다.
    it('퇴직 레코드면 이메일은 null', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(
        row({
          employmentStatus: 'RETIRED',
          account: { email: 'left@test.invalid', status: 'JOINED' },
        }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        employmentStatus: 'RETIRED',
        email: null,
      });
    });

    it('상세만 계정 이메일 · 상태를 읽는다 — 목록은 읽지도 내지도 않는다', async () => {
      await service.findOne(9, 30);
      expect(firstArg(prisma.staffMember.findFirst).select).toMatchObject({
        account: {
          select: { email: true, status: true, isHqSharingConsented: true },
        },
      });

      const listed = (await service.list(9, {}))!.items[0];
      expect(listed).not.toHaveProperty('email');
      // 목록은 본사 제공 동의를 보려고 계정을 읽지만 그 칸 하나뿐이다
      expect(firstArg(prisma.staffMember.findMany).select).toMatchObject({
        account: { select: { isHqSharingConsented: true } },
      });
      expect(
        (
          firstArg(prisma.staffMember.findMany).select as {
            account: { select: object };
          }
        ).account.select,
      ).not.toHaveProperty('email');
    });

    it('관리 범위의 점포 안에서만 그 ID 를 찾는다', async () => {
      await service.findOne(9, 30);
      expect(firstArg(prisma.staffMember.findFirst).where).toEqual({
        staffMemberId: 30,
        storeId: { in: [5, 6] },
      });
    });

    it('없거나 관리 범위 밖이면 null', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(null);
      await expect(service.findOne(9, 30)).resolves.toBeNull();
    });

    it('가려지는 직원(본사 역할 · 가맹 점포 · 동의 없음)은 null — 상세로 열리지 않는다', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(row({ storeId: 6 }));
      await expect(service.findOne(9, 30)).resolves.toBeNull();
    });

    // 가려지는 직원만 점포 · 계약을 더 읽으면 404 가 그만큼 늦어, 응답 시간으로 목록이 숨긴 ID 를 가려낼 수 있다.
    // 없는 직원과 같이 직원 한 건만 읽고 끝나야 한다.
    it('가려지는 직원은 점포 · 계약을 읽지 않고 null — 없는 직원과 응답 시간이 갈리지 않게', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(row({ storeId: 6 }));
      await service.findOne(9, 30);
      expect(prisma.store.findMany).not.toHaveBeenCalled();
      expect(prisma.contract.findMany).not.toHaveBeenCalled();
    });

    // 지금은 앞선 판정과 응답 줄의 가림이 같은 값이라 갈리지 않는다. 응답 줄의 가림 조건만 바뀌어도 상세가 가린 줄을
    // 200 으로 내 숨긴 ID 의 존재를 드러내지 않게, 응답 줄이 가렸으면 그대로 null 이다.
    it('응답 줄이 가린 줄이면 앞선 판정을 지났어도 null', async () => {
      jest
        .spyOn(
          service as unknown as { toItems: () => Promise<unknown[]> },
          'toItems',
        )
        .mockResolvedValue([{ staffMemberId: null, isMasked: true }]);
      await expect(service.findOne(9, 30)).resolves.toBeNull();
    });

    it('본사 제공 동의한 가맹 점포 직원은 가리지 않고 낸다', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(
        row({ storeId: 6, account: { isHqSharingConsented: true } }),
      );
      const item = await service.findOne(9, 30);
      expect(item).toMatchObject({ staffMemberId: 30, isMasked: false });
    });

    it('사용 중인 관리자가 아니면 null', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      await expect(service.findOne(9, 30)).resolves.toBeNull();
      expect(prisma.staffMember.findFirst).not.toHaveBeenCalled();
    });
  });
});
