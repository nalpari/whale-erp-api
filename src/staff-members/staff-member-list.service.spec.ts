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
  joinStatus: 'JOINED',
  employmentStatus: 'EMPLOYED',
  retiredDate: null,
  isHqSharingConsented: false,
  invitations: [],
  ...over,
});

describe('StaffMemberListService', () => {
  let service: StaffMemberListService;
  let scope: { getManageableStores: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    staffMember: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
    };
    store: { findMany: jest.Mock };
    contract: { findMany: jest.Mock };
    workSchedule: { findMany: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
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
      workSchedule: { findMany: jest.fn().mockResolvedValue([]) },
      // 직원 정보 관리 수정 권한. 기본은 있음 — 상세 이메일 테스트가 권한 말고 다른 조건을 보게 한다.
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
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
        { storeId: { in: [6] }, isHqSharingConsented: true },
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
          { storeId: { in: [6] }, isHqSharingConsented: true },
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
        row({ storeId: 6, isHqSharingConsented: true }),
      ]);
      const item = (await service.list(9, {}))!.items[0];
      expect(item.isMasked).toBe(false);
      expect(item.staffMemberId).toBe(30);
      expect(item.name).toBe('서지안');
      expect(item.phone).toBe('01028417702');
      expect(firstArg(prisma.staffMember.findMany).select).toMatchObject({
        isHqSharingConsented: true,
      });
    },
  );

  it('고른 점포가 모두 가맹이면 개인 칸으로 거를 때 동의한 직원만 남는다 — 첫 갈래는 빈 목록', async () => {
    await service.list(9, { storeIds: [6], keyword: '홍길동' });
    expect(where().AND).toContainEqual({
      OR: [
        { storeId: { in: [] } },
        { storeId: { in: [6] }, isHqSharingConsented: true },
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

  it.each([
    ['SIGNUP', 'SENT', true],
    ['SIGNUP', 'EXPIRED', true],
    ['AFFILIATION_CONFIRM', 'SENT', true],
    ['RETURN_CONFIRM', 'SENT', true],
    ['AFFILIATION_CONFIRM', 'REJECTED', false],
    ['SIGNUP', 'REJECTED_UNDER_AGE', false],
  ])(
    '재발송은 간격 없이 상태로만 정한다 — %s %s → %s',
    async (invitationType, status, canResend) => {
      prisma.staffMember.findMany.mockResolvedValue([
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
        }),
      ]);
      const item = (await service.list(9, {}))!.items[0];
      expect(item.invitation?.canResend).toBe(canResend);
    },
  );

  it('최근 계약 정렬은 NULL 을 뒤로, 날짜는 YYYY-MM-DD', async () => {
    prisma.contract.findMany.mockResolvedValue([
      {
        staffMemberId: 30,
        contractId: 4,
        status: 'SIGNED',
        signDeadlineAt: null,
        endDate: new Date('2027-02-28T00:00:00Z'),
        updatedAt: new Date('2026-09-02T05:00:00Z'),
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
    // 점포 직원의 상세는 열지만 재설정 링크는 보낼 수 없다(canManageStaffAccount 404) — 보낼 수 없는 주소는 내지 않는다.
    it('본사 역할(BM)에게 동의한 가맹 점포 직원은 상세를 열어도 이메일은 null — 링크를 보낼 수 없다', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(
        row({
          storeId: 6,
          isHqSharingConsented: true,
          account: { email: 'fc@test.invalid', status: 'JOINED' },
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

    // 이메일은 재설정 링크가 갈 주소를 보이려고 더한 칸이다. 링크를 보낼 수 없는(수정 권한 없는) 관리자에게는 내지
    // 않는다 — 조회만 켠 그룹이 목록에 없던 로그인 아이디를 상세로 받게 된다(api #56 리뷰, api #53 원칙).
    it('직원 정보 관리 수정 권한이 없으면 상세는 그대로 내고 이메일만 null', async () => {
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      prisma.staffMember.findFirst.mockResolvedValue(
        row({ account: { email: 'jian@test.invalid', status: 'JOINED' } }),
      );
      await expect(service.findOne(9, 30)).resolves.toMatchObject({
        staffMemberId: 30,
        email: null,
      });
    });

    it('수정 권한은 발송 가드와 같은 조건으로 묻는다 — 사용 중인 그 관리자의 그룹 · 직원 정보 관리 메뉴 · 수정', async () => {
      await service.findOne(9, 30);
      expect(firstArg(prisma.roleGroupMenu.count).where).toEqual({
        isDeleted: false,
        isUpdatable: true,
        roleGroup: {
          isDeleted: false,
          adminAccounts: {
            some: {
              adminAccountId: 9,
              isDeleted: false,
              accountStatusCode: 'ACTIVE',
            },
          },
        },
        menu: { menuCode: 'MN000005', isDeleted: false, status: 'ACTIVE' },
      });
    });

    // 권한을 묻는지가 직원이 있는지 · 가려지는지에 따라 갈리면 응답 시간으로 다시 가려낼 수 있다(api #53). 직원 조회와
    // 함께 늘 한 번 묻는다.
    it.each([
      ['없는 직원', null],
      ['가려지는 직원', { storeId: 6 }],
      ['보이는 직원', {}],
    ])('권한은 %s 에도 직원 조회와 함께 한 번 묻는다', async (_, over) => {
      prisma.staffMember.findFirst.mockResolvedValue(
        over === null ? null : row(over),
      );
      await service.findOne(9, 30);
      expect(prisma.roleGroupMenu.count).toHaveBeenCalledTimes(1);
    });

    // 발송은 퇴직 레코드에 409 다. 보낼 수 없는 주소라, 전 근무지 관리자에게 퇴직자의 로그인 아이디를 계속 보이지 않는다
    // (2026-10-16 영주).
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
        account: { select: { email: true, status: true } },
      });

      const listed = (await service.list(9, {}))!.items[0];
      expect(listed).not.toHaveProperty('email');
      expect(firstArg(prisma.staffMember.findMany).select).not.toHaveProperty(
        'account',
      );
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
        row({ storeId: 6, isHqSharingConsented: true }),
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
