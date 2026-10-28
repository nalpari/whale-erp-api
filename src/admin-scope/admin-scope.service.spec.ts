import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminScopeService,
  consentOpensStore,
  hiddenStoreStaffWhere,
  hidesPersonalData,
} from './admin-scope.service';
import { HQ_SHARING_CONSENT_VERSION, HQ_SHARING_CONSENTED } from './hq-sharing';

describe('AdminScopeService', () => {
  let scope: AdminScopeService;
  let prisma: {
    staffMember: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    adminAccount: { findFirst: jest.Mock };
    store: { findFirst: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    adminStoreMapping: { count: jest.Mock };
    bpCode: { findFirst: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      staffMember: {
        findUnique: jest.fn().mockResolvedValue({
          storeId: 5,
          account: { isHqSharingConsented: false },
        }),
        findFirst: jest.fn().mockResolvedValue({ storeId: 5 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({
          bpCodeId: 2,
          isAllStores: false,
          roleTypeCode: 'BA',
        }),
      },
      store: {
        findFirst: jest.fn().mockResolvedValue({ storeTypeCode: 'DIRECT' }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ storeId: 5, storeTypeCode: 'DIRECT' }]),
        count: jest.fn().mockResolvedValue(0),
      },
      adminStoreMapping: { count: jest.fn().mockResolvedValue(1) },
      bpCode: {
        findFirst: jest.fn().mockResolvedValue({ bpCodeId: 7 }),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
    };
    const module = await Test.createTestingModule({
      providers: [
        AdminScopeService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    scope = module.get(AdminScopeService);
  });

  const can = () => scope.canManageStaffMember(9, 30);

  describe('canManageStaffMember — 직원 단위 API(퇴직 처리)는 직원의 본사 제공 동의를 따른다', () => {
    const managing = (roleTypeCode: string, storeTypeCode: string) => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
        roleTypeCode,
      });
      prisma.store.findMany.mockResolvedValue([{ storeId: 5, storeTypeCode }]);
    };
    /** 본사 제공 동의는 계정에 있다(2026-10-20). null 이면 가입 전 — 계정이 없다 */
    const staffIs = (isHqSharingConsented: boolean | null) =>
      prisma.staffMember.findFirst.mockResolvedValue({
        storeId: 5,
        account:
          isHqSharingConsented === null
            ? null
            : {
                isHqSharingConsented,
                hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
              },
      });

    // 직원을 먼저 찾고 그 점포를 관리하는지 보면, 다른 BP 직원 ID 는 없는 ID 보다 쿼리가 더 돌아 같은 404 라도
    // 응답 시간으로 그 ID 의 직원이 있는지 드러난다(api #56 리뷰). 관리 범위를 먼저 정하고 그 안에서만 찾는다.
    it('관리 범위를 먼저 정하고 그 점포 안에서만 직원을 찾는다', async () => {
      staffIs(false);
      await expect(can()).resolves.toBe(true);
      expect(prisma.staffMember.findFirst).toHaveBeenCalledWith({
        where: { staffMemberId: 30, storeId: { in: [5] } },
        select: {
          storeId: true,
          account: {
            select: {
              isHqSharingConsented: true,
              hqSharingConsentVersion: true,
            },
          },
        },
      });
      expect(prisma.staffMember.findUnique).not.toHaveBeenCalled();
    });

    it('없거나 관리 범위 밖 직원이면 안 된다', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(null);
      await expect(can()).resolves.toBe(false);
    });

    it.each([
      [
        '범위 안 직원',
        { storeId: 5, account: { isHqSharingConsented: false } },
      ],
      ['없거나 다른 BP 직원', null],
    ])('%s 도 같은 쿼리를 같은 횟수로 묻는다', async (_, found) => {
      prisma.staffMember.findFirst.mockResolvedValue(found);
      await can();
      expect([
        prisma.adminAccount.findFirst.mock.calls.length,
        prisma.store.findMany.mock.calls.length,
        prisma.staffMember.findFirst.mock.calls.length,
        prisma.store.findFirst.mock.calls.length,
        prisma.adminStoreMapping.count.mock.calls.length,
      ]).toEqual([1, 1, 1, 0, 0]);
    });

    it('사용 중이 아니거나 지운 관리자 계정이면 직원을 묻지 않고 안 된다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(can()).resolves.toBe(false);
      expect(prisma.staffMember.findFirst).not.toHaveBeenCalled();
    });

    it.each(['BM', 'BA'])(
      '%s 는 동의하지 않은 가맹 점포 직원을 다루지 못한다 — 목록에서 가린 직원이다(ATT-30)',
      async (roleTypeCode) => {
        managing(roleTypeCode, 'FRANCHISE');
        staffIs(false);
        await expect(can()).resolves.toBe(false);
      },
    );

    it.each(['BM', 'BA'])(
      '%s 도 본사 제공 동의한 가맹 점포 직원은 다룬다',
      async (roleTypeCode) => {
        managing(roleTypeCode, 'FRANCHISE');
        staffIs(true);
        await expect(can()).resolves.toBe(true);
      },
    );

    it.each(['BM', 'BA'])(
      '%s 는 가입 전(계정 없음) 가맹 점포 직원을 다루지 못한다 — 동의할 계정이 아직 없다',
      async (roleTypeCode) => {
        managing(roleTypeCode, 'FRANCHISE');
        staffIs(null);
        await expect(can()).resolves.toBe(false);
      },
    );

    it('점포 유형을 모르면 본사 역할에게 가린다 — 틀릴 때 가리는 쪽', async () => {
      managing('BM', 'UNKNOWN');
      staffIs(false);
      await expect(can()).resolves.toBe(false);
    });

    it.each(['FM', 'FA'])(
      '%s 는 자기 가맹 점포 직원을 다룬다',
      async (roleTypeCode) => {
        managing(roleTypeCode, 'FRANCHISE');
        staffIs(false);
        await expect(can()).resolves.toBe(true);
      },
    );
  });

  describe('canManageStaffAt — 점포로 묻는다(근로계약 근무지)', () => {
    it('관리하고 가려지지 않는 점포면 된다', async () => {
      await expect(scope.canManageStaffAt(9, 5, false)).resolves.toBe(true);
      expect(prisma.staffMember.findUnique).not.toHaveBeenCalled();
    });

    it('본사 역할에게 가맹 점포는 안 된다', async () => {
      prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });
      await expect(scope.canManageStaffAt(9, 5, false)).resolves.toBe(false);
    });

    it('관리하지 않는 점포면 안 된다', async () => {
      prisma.adminStoreMapping.count.mockResolvedValue(0);
      await expect(scope.canManageStaffAt(9, 5, false)).resolves.toBe(false);
    });
  });

  // 본사 제공 동의는 자료를 보는 데 대한 동의라 계정 조치로 넓히지 않는다(2026-10-14 재영, api #21).
  describe('canManageStaffAccount — 계정 조치(재설정 링크)는 동의와 상관없이 점포 단위', () => {
    const canAccount = () => scope.canManageStaffAccount(9, 30);
    const managing = (roleTypeCode: string, storeTypeCode: string) => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
        roleTypeCode,
      });
      prisma.store.findMany.mockResolvedValue([{ storeId: 5, storeTypeCode }]);
    };

    it.each(['BM', 'BA'])(
      '%s 는 본사 제공 동의한 가맹 점포 직원이어도 안 된다',
      async (roleTypeCode) => {
        managing(roleTypeCode, 'FRANCHISE');
        await expect(canAccount()).resolves.toBe(false);
      },
    );

    it.each(['FM', 'FA'])(
      '%s 는 자기 가맹 점포 직원이면 된다',
      async (roleTypeCode) => {
        managing(roleTypeCode, 'FRANCHISE');
        await expect(canAccount()).resolves.toBe(true);
      },
    );

    it('본사 역할도 직영 점포 직원이면 된다', async () => {
      managing('BM', 'DIRECT');
      await expect(canAccount()).resolves.toBe(true);
    });

    it('없거나 관리 범위 밖 직원이면 안 된다', async () => {
      prisma.staffMember.findFirst.mockResolvedValue(null);
      await expect(canAccount()).resolves.toBe(false);
    });

    // 직원을 먼저 찾고 그 점포를 관리하는지 보면, 다른 BP 직원 ID 는 없는 ID 보다 쿼리가 더 돌아 같은 404 라도
    // 응답 시간으로 그 ID 의 직원이 있는지 드러난다(api #56 리뷰). 상세(findOne)처럼 관리 범위를 먼저 정하고 그 안에서만
    // 찾는다.
    it('관리 범위를 먼저 정하고 그 점포 안에서만 직원을 찾는다', async () => {
      await canAccount();
      expect(prisma.staffMember.findFirst).toHaveBeenCalledWith({
        where: { staffMemberId: 30, storeId: { in: [5] } },
        select: {
          storeId: true,
          account: {
            select: {
              isHqSharingConsented: true,
              hqSharingConsentVersion: true,
            },
          },
        },
      });
      expect(prisma.staffMember.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['범위 안 직원', { storeId: 5 }],
      ['없거나 다른 BP 직원', null],
    ])('%s 도 같은 쿼리를 같은 횟수로 묻는다', async (_, found) => {
      prisma.staffMember.findFirst.mockResolvedValue(found);
      await canAccount();
      expect([
        prisma.adminAccount.findFirst.mock.calls.length,
        prisma.store.findMany.mock.calls.length,
        prisma.staffMember.findFirst.mock.calls.length,
        prisma.store.findFirst.mock.calls.length,
        prisma.adminStoreMapping.count.mock.calls.length,
      ]).toEqual([1, 1, 1, 0, 0]);
    });

    it('사용 중인 관리자가 아니면 직원을 묻지 않고 안 된다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(canAccount()).resolves.toBe(false);
      expect(prisma.staffMember.findFirst).not.toHaveBeenCalled();
    });
  });

  it('본사 역할도 가맹 점포 자체는 관리한다 — 가리는 것은 직원 개인이다', async () => {
    prisma.store.findFirst.mockResolvedValue({ storeTypeCode: 'FRANCHISE' });

    await expect(scope.canManageStore(9, 5)).resolves.toBe(true);
  });

  describe('hidesPersonalData', () => {
    it.each([
      ['BM', 'FRANCHISE', false, true],
      ['BA', 'FRANCHISE', false, true],
      ['BM', undefined, false, true],
      ['BM', 'FRANCHISE', true, false],
      ['BA', 'FRANCHISE', true, false],
      ['BM', 'DIRECT', false, false],
      ['BA', 'DIRECT', false, false],
      ['FM', 'FRANCHISE', false, false],
      ['FA', 'FRANCHISE', false, false],
      ['PM', 'FRANCHISE', false, false],
    ] as const)(
      '%s · %s · 동의 %s → %s',
      (role, storeType, consented, hidden) => {
        const store = storeType && {
          storeTypeCode: storeType,
          storeStatusCode: 'OPERATING',
        };
        expect(hidesPersonalData(role, store, consented)).toBe(hidden);
      },
    );

    it.each([
      ['BM', 'FRANCHISE', true, true],
      ['BA', 'FRANCHISE', true, true],
      ['BM', 'DIRECT', false, false],
      ['FA', 'FRANCHISE', false, false],
    ] as const)(
      '폐점 점포 — %s · %s · 동의 %s → %s (가맹 관계가 끝난 레코드에는 동의를 적용하지 않는다, ATT-30 v227)',
      (role, storeTypeCode, consented, hidden) => {
        const closed = { storeTypeCode, storeStatusCode: 'CLOSED' };
        expect(hidesPersonalData(role, closed, consented)).toBe(hidden);
      },
    );

    it('consentOpensStore — 동의한 직원은 보이는 점포는 운영 중인 가맹 점포뿐', () => {
      const store = (storeTypeCode: string, storeStatusCode: string) => ({
        storeTypeCode,
        storeStatusCode,
      });
      expect(consentOpensStore('BM', store('FRANCHISE', 'OPERATING'))).toBe(
        true,
      );
      expect(consentOpensStore('BM', store('FRANCHISE', 'CLOSED'))).toBe(false);
      expect(consentOpensStore('BM', store('DIRECT', 'OPERATING'))).toBe(false);
      expect(consentOpensStore('FA', store('FRANCHISE', 'OPERATING'))).toBe(
        false,
      );
      expect(consentOpensStore('BM', undefined)).toBe(false);
    });

    it('hiddenStoreStaffWhere — 운영 중인 가맹 점포는 동의한 직원, 폐점이면 아무도 걸리지 않는다', () => {
      expect(
        hiddenStoreStaffWhere('BM', {
          storeTypeCode: 'FRANCHISE',
          storeStatusCode: 'OPERATING',
        }),
      ).toBe(HQ_SHARING_CONSENTED);
      expect(
        hiddenStoreStaffWhere('BM', {
          storeTypeCode: 'FRANCHISE',
          storeStatusCode: 'CLOSED',
        }),
      ).toEqual({ account: { is: { accountId: { in: [] } } } });
    });
  });

  describe('getManageableStores', () => {
    const get = () => scope.getManageableStores(9);

    it('역할과 점포를 준다 — 매핑 관리자는 삭제되지 않은 매핑의 점포만', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: false,
        roleTypeCode: 'BA',
      });

      await expect(get()).resolves.toEqual({
        roleTypeCode: 'BA',
        stores: [{ storeId: 5, storeTypeCode: 'DIRECT' }],
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 2,
          isDeleted: false,
          adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
        },
        select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('전체 점포 관리자는 매핑을 보지 않고 자기 BP 의 점포 전부', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
        roleTypeCode: 'BM',
      });

      await get();
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 2, isDeleted: false },
        select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('사용 중인 계정만 본다 — 없거나 미사용이면 null', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(get()).resolves.toBeNull();
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
      });
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });
  });

  // 탭 BP(@TargetBp)를 넘기면 플랫폼 계정은 그 BP 의 점포 전부를 다룬다. BP · 가맹 계정은 `bp` 를 보지 않아
  // 넘기지 않을 때와 같다(2026-10-26 재영, WHALEERP-618).
  describe('대상 BP(@TargetBp)', () => {
    const platformBp = { bpCodeId: 7, isPlatformCaller: true };
    const asPlatform = () =>
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 1,
        isAllStores: false,
        roleTypeCode: 'PM',
      });

    it('플랫폼 계정은 대상 BP 의 점포 전부 — 매핑을 보지 않는다', async () => {
      asPlatform();
      await expect(scope.getManageableStores(9, platformBp)).resolves.toEqual({
        roleTypeCode: 'PM',
        stores: [{ storeId: 5, storeTypeCode: 'DIRECT' }],
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 7, isDeleted: false },
        select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('BP · 가맹 계정은 넘긴 BP 를 보지 않는다 — 소속 BP 와 매핑', async () => {
      // 소속 BP(2)와 다른 BP 를 넘겨야 「무시」와 「bp.bpCodeId 를 씀」이 갈린다.
      const otherBp = { bpCodeId: 3, isPlatformCaller: false };
      await scope.getManageableStores(9, otherBp);
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 2,
          isDeleted: false,
          adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
        },
        select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
        orderBy: { storeId: 'asc' },
      });

      await scope.canManageStore(9, 5, otherBp);
      expect(prisma.store.findFirst).toHaveBeenCalledWith({
        where: { storeId: 5, bpCodeId: 2, isDeleted: false },
        select: { storeTypeCode: true, storeStatusCode: true },
      });
      expect(prisma.adminStoreMapping.count).toHaveBeenCalled();
    });

    it.each([
      [
        'canManageStaffMember',
        () => scope.canManageStaffMember(9, 30, platformBp),
      ],
      [
        'canManageStaffAccount',
        () => scope.canManageStaffAccount(9, 30, platformBp),
      ],
    ])(
      '플랫폼 계정은 대상 BP 의 가맹 점포 직원도 가리지 않는다 — %s',
      async (_name, call) => {
        asPlatform();
        // 대상 BP 를 매핑 없이 물을 때만 점포가 나온다 — `bp` 가 빠지면 소속 BP · 매핑으로 물어 false 다.
        prisma.store.findMany.mockImplementation(
          ({
            where,
          }: {
            where: { bpCodeId: number; adminMappings?: unknown };
          }) =>
            Promise.resolve(
              where.bpCodeId === 7 && !where.adminMappings
                ? [{ storeId: 5, storeTypeCode: 'FRANCHISE' }]
                : [],
            ),
        );
        // 직원도 범위의 점포 안에서만 찾는다 — 기본 mock 은 `storeId: { in }` 을 보지 않아 빈 범위에서도 직원이 나온다.
        prisma.staffMember.findFirst.mockImplementation(
          ({ where }: { where: { storeId: { in: number[] } } }) =>
            Promise.resolve(
              where.storeId.in.includes(5) ? { storeId: 5 } : null,
            ),
        );
        await expect(call()).resolves.toBe(true);
      },
    );

    it('사용 중이 아닌 플랫폼 계정은 대상 BP 를 넘겨도 아무 점포도 다루지 못한다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(
        scope.getManageableStores(9, platformBp),
      ).resolves.toBeNull();
      await expect(scope.canManageStore(9, 5, platformBp)).resolves.toBe(false);
      await expect(
        scope.canManageStaffAt(9, 5, false, platformBp),
      ).resolves.toBe(false);
      await expect(scope.canManageStaffMember(9, 30, platformBp)).resolves.toBe(
        false,
      );
      await expect(
        scope.canManageStaffAccount(9, 30, platformBp),
      ).resolves.toBe(false);
      expect(prisma.store.findMany).not.toHaveBeenCalled();
      expect(prisma.store.findFirst).not.toHaveBeenCalled();
      expect(prisma.staffMember.findFirst).not.toHaveBeenCalled();
    });

    it('PM · PA 가 아닌 계정은 플랫폼 표시가 붙은 BP 를 넘겨도 소속 BP 와 매핑이다', async () => {
      // 가드 밖에서 손으로 만든 값이 BP 계정을 다른 BP 전체로 넓히지 못한다.
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: false,
        roleTypeCode: 'BM',
      });
      await scope.getManageableStores(9, platformBp);
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 2,
          isDeleted: false,
          adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
        },
        select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
        orderBy: { storeId: 'asc' },
      });
    });

    it('플랫폼 계정도 대상 BP 밖의 점포는 다루지 못한다', async () => {
      asPlatform();
      prisma.store.findFirst.mockResolvedValue(null);
      await expect(scope.canManageStore(9, 5, platformBp)).resolves.toBe(false);
      await expect(
        scope.canManageStaffAt(9, 5, false, platformBp),
      ).resolves.toBe(false);
    });

    it('플랫폼 계정의 점포 판정은 대상 BP 에서 찾고 매핑을 보지 않는다', async () => {
      asPlatform();
      await expect(
        scope.canManageStaffAt(9, 5, false, platformBp),
      ).resolves.toBe(true);
      await expect(scope.canManageStore(9, 5, platformBp)).resolves.toBe(true);
      expect(prisma.store.findFirst).toHaveBeenCalledWith({
        where: { storeId: 5, bpCodeId: 7, isDeleted: false },
        select: { storeTypeCode: true, storeStatusCode: true },
      });
      expect(prisma.adminStoreMapping.count).not.toHaveBeenCalled();
    });
  });

  describe('isPlatformAdmin', () => {
    it('사용 중인 플랫폼 BP 의 PM · PA 계정만 true — 역할이 고객 BP 계정에 잘못 붙어도 막는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleTypeCode: 'PM',
        bpCode: { isPlatform: true },
      });
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(true);
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleTypeCode: 'PM',
        bpCode: { isPlatform: false },
      });
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(false);
    });

    it('아니면 false', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(false);
    });
  });

  describe('listStores — canManageStore 와 같은 규칙의 목록', () => {
    const select = {
      storeId: true,
      storeCode: true,
      name: true,
      storeTypeCode: true,
      storeStatusCode: true,
    };
    const orderBy = [{ name: 'asc' }, { storeId: 'asc' }];

    it('매핑으로 관리하면 그 BP 의 매핑된 점포만', async () => {
      await scope.listStores(9);
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: {
          bpCodeId: 2,
          isDeleted: false,
          adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
        },
        select,
        orderBy,
      });
    });

    it('전체 점포 관리자는 그 BP 의 모든 점포', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 2,
        isAllStores: true,
      });
      await scope.listStores(9);
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 2, isDeleted: false },
        select,
        orderBy,
      });
    });

    it('사용 중인 계정이 아니면 빈 목록', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(scope.listStores(9)).resolves.toEqual([]);
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });
  });

  describe('bpStoresAccess — BP 점포 목록을 볼 수 있는가', () => {
    const admin = { type: 'admin' as const, id: 9, loginId: 'a', sid: 1 };
    const staff = {
      type: 'account' as const,
      id: 30,
      email: 's@test.invalid',
      sid: 1,
    };

    it('플랫폼 BP 의 PM · PA 는 어느 BP 든 된다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 1,
        roleTypeCode: 'PA',
        bpCode: { isPlatform: true },
      });
      await expect(scope.bpStoresAccess(admin, 7)).resolves.toBe('allowed');
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: {
          bpCodeId: true,
          roleTypeCode: true,
          bpCode: { select: { isPlatform: true } },
        },
      });
    });

    it('BP · 가맹 관리자는 자기 BP 만', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 7,
        roleTypeCode: 'BA',
        bpCode: { isPlatform: false },
      });
      await expect(scope.bpStoresAccess(admin, 7)).resolves.toBe('allowed');
      await expect(scope.bpStoresAccess(admin, 8)).resolves.toBe('denied');
    });

    it('사용 중인 관리자 계정이 아니면 unavailable', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(scope.bpStoresAccess(admin, 7)).resolves.toBe('unavailable');
    });

    it('직원 앱은 가입 · 재직 중인 직원 레코드의 점포가 그 BP 에 있을 때만', async () => {
      prisma.staffMember.findMany.mockResolvedValue([{ storeId: 5 }]);
      prisma.store.count.mockResolvedValue(1);
      await expect(scope.bpStoresAccess(staff, 7)).resolves.toBe('allowed');
      expect(prisma.staffMember.findMany).toHaveBeenCalledWith({
        where: {
          accountId: 30,
          joinStatus: 'JOINED',
          employmentStatus: 'EMPLOYED',
        },
        select: { storeId: true },
      });
      expect(prisma.store.count).toHaveBeenCalledWith({
        where: { storeId: { in: [5] }, bpCodeId: 7, isDeleted: false },
      });

      prisma.store.count.mockResolvedValue(0);
      await expect(scope.bpStoresAccess(staff, 8)).resolves.toBe('denied');
      prisma.staffMember.findMany.mockResolvedValue([]);
      await expect(scope.bpStoresAccess(staff, 7)).resolves.toBe('denied');
    });
  });

  describe('platformAdminAccess — 플랫폼 전용 조회(BP 선택 목록)', () => {
    it('플랫폼 BP 의 PM · PA 만 allowed', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleTypeCode: 'PA',
        bpCode: { isPlatform: true },
      });
      await expect(scope.platformAdminAccess(9)).resolves.toBe('allowed');
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: {
          roleTypeCode: true,
          bpCode: { select: { isPlatform: true } },
        },
      });
    });

    it('BP · 가맹 관리자, 고객 BP 에 붙은 PM 은 denied', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleTypeCode: 'BM',
        bpCode: { isPlatform: false },
      });
      await expect(scope.platformAdminAccess(9)).resolves.toBe('denied');
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleTypeCode: 'PM',
        bpCode: { isPlatform: false },
      });
      await expect(scope.platformAdminAccess(9)).resolves.toBe('denied');
      // 플랫폼 BP 에 붙은 PM · PA 아닌 역할도 막는다 — 소속만 보면 통과한다.
      prisma.adminAccount.findFirst.mockResolvedValue({
        roleTypeCode: 'BM',
        bpCode: { isPlatform: true },
      });
      await expect(scope.platformAdminAccess(9)).resolves.toBe('denied');
      await expect(scope.isPlatformAdmin(9)).resolves.toBe(false);
    });

    it('사용 중인 관리자 계정이 아니면 unavailable', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(scope.platformAdminAccess(9)).resolves.toBe('unavailable');
    });
  });

  describe('listBps — 플랫폼 계정이 고를 고객 BP', () => {
    beforeEach(() => {
      prisma.bpCode.findMany.mockResolvedValue([{ bpCodeId: 7 }]);
      prisma.bpCode.count.mockResolvedValue(31);
    });

    it('미삭제 고객 BP 를 상태와 상관없이 BP코드순으로 나눠 준다', async () => {
      await expect(scope.listBps({ page: 3, pageSize: 10 })).resolves.toEqual({
        items: [{ bpCodeId: 7 }],
        total: 31,
      });
      const where = { isDeleted: false, isPlatform: false };
      expect(prisma.bpCode.findMany).toHaveBeenCalledWith({
        where,
        select: {
          bpCodeId: true,
          bpCode: true,
          tradeName: true,
          accountStatusCode: true,
        },
        orderBy: [{ bpCode: 'asc' }, { bpCodeId: 'asc' }],
        skip: 20,
        take: 10,
      });
      expect(prisma.bpCode.count).toHaveBeenCalledWith({ where });
    });

    it('keyword 는 상호 · BP코드 부분 일치(대소문자 무시)를 목록과 total 에 같이 건다', async () => {
      await scope.listBps({ keyword: 'bp0001', page: 1, pageSize: 20 });
      const where = {
        isDeleted: false,
        isPlatform: false,
        OR: [
          { tradeName: { contains: 'bp0001', mode: 'insensitive' } },
          { bpCode: { contains: 'bp0001', mode: 'insensitive' } },
        ],
      };
      expect(prisma.bpCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(prisma.bpCode.count).toHaveBeenCalledWith({ where });
    });

    it('keyword 의 LIKE 와일드카드(% · _)는 글자 그대로 찾는다', async () => {
      await scope.listBps({ keyword: 'BP_1%', page: 1, pageSize: 20 });
      expect(prisma.bpCode.count).toHaveBeenCalledWith({
        where: {
          isDeleted: false,
          isPlatform: false,
          OR: [
            { tradeName: { contains: 'BP\\_1\\%', mode: 'insensitive' } },
            { bpCode: { contains: 'BP\\_1\\%', mode: 'insensitive' } },
          ],
        },
      });
    });
  });

  describe('listBpStores', () => {
    it('고객 BP 의 미삭제 점포 전체 — 운영 상태와 상관없이', async () => {
      prisma.store.findMany.mockResolvedValue([{ storeId: 1 }]);
      await expect(scope.listBpStores(7)).resolves.toEqual([{ storeId: 1 }]);
      expect(prisma.bpCode.findFirst).toHaveBeenCalledWith({
        where: { bpCodeId: 7, isDeleted: false, isPlatform: false },
        select: { bpCodeId: true },
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { bpCodeId: 7, isDeleted: false },
        select: {
          storeId: true,
          storeCode: true,
          name: true,
          storeTypeCode: true,
          storeStatusCode: true,
        },
        orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
      });
    });

    it('없거나 삭제된 BP · 플랫폼 BP 면 null', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(scope.listBpStores(7)).resolves.toBeNull();
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });
  });
});
