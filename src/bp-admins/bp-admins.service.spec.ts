import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { PLATFORM_ADMIN_MAIL } from '../platform-admins/platform-admin-mail';
import { PrismaService } from '../prisma/prisma.service';
import { BpAdminsService } from './bp-admins.service';

// jest 의 비대칭 매처 · mock.calls 는 any 다. 꺼내 쓸 때 lint 가 막지 않게 타입을 붙인다.
const partial = (o: object) => expect.objectContaining(o) as object;
const argOf = <T>(mock: jest.Mock, i = 0): T =>
  (mock.mock.calls[i] as unknown[])[0] as T;
type Args = { where: Record<string, unknown>; data?: unknown };
const txTimeout = () =>
  new Prisma.PrismaClientKnownRequestError('expired transaction', {
    code: 'P2028',
    clientVersion: 'test',
  });

/**
 * 간단한 where 판정 — 이 서비스가 쓰는 꼴(같음 · in · not)과, 행이 객체로 들고 있는 단일 관계(roleGroup 등)를 본다.
 * 목록 관계(storeMappings) · OR · AND 는 건너뛴다. 연쇄의 연결 가맹 마스터 조건이 여기서 걸러져야 다른 가맹 마스터의
 * 가맹 관리자가 섞이는 회귀를 잡는다. 쿼리 모양이 규칙인 곳(목록의 where)은 따로 단언한다.
 */
function matches(row: Record<string, unknown>, where: object = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!(key in row)) return true;
    const value = row[key];
    if (Array.isArray(value)) return true;
    if (value && typeof value === 'object' && !(value instanceof Date))
      return matches(value as Record<string, unknown>, cond as object);
    if (cond === null || typeof cond !== 'object' || cond instanceof Date)
      return value === cond;
    const c = cond as { in?: unknown[]; not?: unknown };
    if ('in' in c) return c.in!.includes(value);
    if ('not' in c)
      return typeof c.not === 'object' && c.not !== null && 'in' in c.not
        ? !(c.not as { in: unknown[] }).in.includes(value)
        : value !== c.not;
    return true;
  });
}

const BP = 100;
const bp: TargetBpContext = { bpCodeId: BP, isPlatformCaller: false };
const updatedAt = new Date('2026-10-23T00:00:00.000Z');

// 점포 1~4 직영(4 는 폐점), 5~8 가맹.
const stores = [1, 2, 3, 4, 5, 6, 7, 8].map((storeId) => ({
  storeId,
  storeCode: `ST00000${storeId}`,
  name: `점포${storeId}`,
  storeTypeCode: storeId <= 4 ? 'DIRECT' : 'FRANCHISE',
  storeStatusCode: storeId === 4 ? 'CLOSED' : 'OPERATING',
  bpCodeId: BP,
  isDeleted: false,
}));

const group = (
  roleGroupId: number,
  roleCode: string,
  roleTypeCode: string,
  managerAdminAccountId: number | null = null,
) => ({
  roleGroupId,
  roleCode,
  name: `그룹${roleCode}`,
  roleTypeCode,
  managerAdminAccountId,
  bpCodeId: roleTypeCode === 'FM' ? 1 : BP,
  isDeleted: false,
  isMaster: roleCode.endsWith('000001'),
});
const groups = [
  group(10, 'BM000001', 'BM'),
  group(11, 'BA000002', 'BA'),
  group(12, 'BA000003', 'BA'),
  group(13, 'FM000001', 'FM'),
  group(14, 'FA000002', 'FA', 20),
  group(15, 'FA000003', 'FA', 21),
];
const groupOf = (id: number) => groups.find((g) => g.roleGroupId === id)!;

const account = (
  adminAccountId: number,
  roleTypeCode: string,
  roleGroupId: number,
  storeIds: number[] | 'ALL',
  o: Record<string, unknown> = {},
) => ({
  adminAccountId,
  loginId: `user${adminAccountId}`,
  name: `사용자${adminAccountId}`,
  phone: '01012345678',
  email: `user${adminAccountId}@whale.test`,
  roleTypeCode,
  roleGroupId,
  roleGroup: groupOf(roleGroupId),
  accountStatusCode: 'ACTIVE',
  isAllStores: storeIds === 'ALL',
  storeMappings:
    storeIds === 'ALL' ? [] : storeIds.map((storeId) => ({ storeId })),
  bpCodeId: BP,
  bpCode: { isPlatform: false },
  isDeleted: false,
  updatedAt,
  ...o,
});

describe('BpAdminsService', () => {
  let service: BpAdminsService;
  let mail: { send: jest.Mock };
  let accounts: ReturnType<typeof account>[];
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    adminAccount: Record<string, jest.Mock>;
    roleGroup: Record<string, jest.Mock>;
    store: Record<string, jest.Mock>;
    adminStoreMapping: Record<string, jest.Mock>;
    adminChangeHistory: Record<string, jest.Mock>;
    bpCode: Record<string, jest.Mock>;
    temporaryPassword: Record<string, jest.Mock>;
  };

  beforeEach(async () => {
    accounts = [
      account(1, 'BM', 10, 'ALL'),
      account(2, 'BA', 11, [1, 2]),
      account(20, 'FM', 13, [5, 6, 7, 8]),
      account(21, 'FM', 13, [3]),
      account(30, 'FA', 14, [6, 7]),
      account(31, 'FA', 14, [8]),
      // 다른 가맹 마스터(21) 아래 가맹 관리자 — 20 의 연쇄가 닿으면 안 된다
      account(32, 'FA', 15, [3]),
      account(40, 'BA', 12, [1, 5]),
      account(99, 'PA', 10, 'ALL', {
        bpCodeId: 1,
        bpCode: { isPlatform: true },
      }),
    ];
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
    const pick = (where?: object) =>
      accounts.find((a) => matches(a, where)) ?? null;
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn((sql: TemplateStringsArray) =>
        Promise.resolve(lockedRow(sql)),
      ),
      $executeRaw: jest.fn().mockResolvedValue(1),
      adminAccount: {
        findFirst: jest.fn(({ where }: Args) => Promise.resolve(pick(where))),
        findMany: jest.fn(({ where }: Args) =>
          Promise.resolve(
            accounts
              .filter((a) => matches(a, where))
              .map((a) => ({
                ...a,
                _count: { storeMappings: a.storeMappings.length },
              })),
          ),
        ),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ adminAccountId: 50 }),
        update: jest.fn().mockResolvedValue({ updatedAt }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ updatedAt }),
      },
      roleGroup: {
        findFirst: jest.fn(({ where }: Args) =>
          Promise.resolve(groups.find((g) => matches(g, where)) ?? null),
        ),
        findMany: jest.fn(({ where }: Args) =>
          Promise.resolve(groups.filter((g) => matches(g, where))),
        ),
      },
      store: {
        findMany: jest.fn(({ where }: Args) =>
          Promise.resolve(stores.filter((s) => matches(s, where))),
        ),
        count: jest.fn().mockResolvedValue(stores.length),
      },
      adminStoreMapping: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      bpCode: {
        findFirst: jest.fn().mockResolvedValue({ tradeName: '모리커피' }),
      },
      temporaryPassword: {
        create: jest.fn().mockResolvedValue({ temporaryPasswordId: 7 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue({ temporaryPasswordId: 7 }),
      },
    };
    prisma.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        BpAdminsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PLATFORM_ADMIN_MAIL,
          useValue: { mail, webUrl: 'https://admin.whale.test' },
        },
      ],
    }).compile();
    service = moduleRef.get(BpAdminsService);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  /**
   * 행 잠금을 기다리는 사이 다른 트랜잭션이 커밋한 것을 흉내 낸다 — pattern 에 맞는 $queryRaw(FOR SHARE)가 불리는
   * 순간 onLock 이 데이터를 바꾼다. onLock 이 배열을 돌려주면 그것이 조회 결과(빈 배열 = 잠글 행이 없음)다.
   */
  const whileLocked = (pattern: RegExp, onLock: () => unknown[] | void) =>
    prisma.$queryRaw.mockImplementation((sql: TemplateStringsArray) =>
      pattern.test(sql.join('?'))
        ? Promise.resolve(onLock() ?? lockedRow(sql))
        : Promise.resolve(lockedRow(sql)),
    );
  const masterRow = /admin_accounts[\s\S]*FOR SHARE/;
  const groupRow = /role_groups[\s\S]*FOR SHARE/;
  const bpRow = /bp_codes[\s\S]*FOR SHARE/;
  /** 잠근 BP 행을 다시 읽은 값. 기본은 사용 중이다. */
  const liveBp = { account_status_code: 'ACTIVE', is_deleted: false };
  const lockedRow = (sql: TemplateStringsArray) =>
    bpRow.test(sql.join('?')) ? [liveBp] : [{ ok: 1 }];
  /** 트랜잭션을 연 뒤 prisma 에 처음 나간 호출 — 잠금 순서를 본다. */
  const firstInTx = () => {
    const start = prisma.$transaction.mock.invocationCallOrder[0];
    const calls = Object.values(prisma)
      .flatMap((v) => (jest.isMockFunction(v) ? [v] : Object.values(v)))
      .flatMap((m: jest.Mock) =>
        m.mock.invocationCallOrder.map((order, i) => ({
          order,
          args: m.mock.calls[i] as unknown[],
        })),
      )
      .filter((c) => c.order > start)
      .sort((a, b) => a.order - b.order);
    const first = calls[0].args[0];
    return Array.isArray(first) ? first.join('?') : JSON.stringify(first);
  };
  const patchAccount = (id: number, o: Record<string, unknown>) => {
    const i = accounts.findIndex((a) => a.adminAccountId === id);
    accounts[i] = { ...accounts[i], ...o };
  };

  const historyRows = () =>
    prisma.adminChangeHistory.createMany.mock.calls.flatMap(
      (c) => (c as [{ data: Record<string, unknown>[] }])[0].data,
    );

  describe('호출자', () => {
    it('플랫폼 사용자가 BP 를 고르지 않으면(헤더 없음 → 플랫폼 BP) 400', async () => {
      await expect(
        service.list(
          99,
          { bpCodeId: 1, isPlatformCaller: true },
          {
            page: 1,
            pageSize: 20,
          },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('다른 BP 소속 계정이 부르면 403', async () => {
      accounts[1] = { ...accounts[1], bpCodeId: 200 };
      await expect(
        service.list(2, bp, { page: 1, pageSize: 20 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('list', () => {
    const whereOf = () => argOf<Args>(prisma.adminAccount.findMany).where;

    it('본사는 대상 BP 의 세 역할 계정을, 등록일시 최신순으로', async () => {
      await service.list(2, bp, { page: 2, pageSize: 20 });
      expect(prisma.adminAccount.findMany).toHaveBeenCalledWith(
        partial({
          where: partial({
            bpCodeId: BP,
            isDeleted: false,
            roleTypeCode: { in: ['BA', 'FM', 'FA'] },
          }),
          orderBy: [{ createdAt: 'desc' }, { adminAccountId: 'desc' }],
          skip: 20,
          take: 20,
        }),
      );
    });

    it('역할을 고르면 그 역할만 — 목록과 total 이 같은 조건', async () => {
      await service.list(2, bp, {
        page: 1,
        pageSize: 20,
        roleTypeCodes: ['FM', 'FA'],
      });
      expect(whereOf()).toEqual(
        partial({ roleTypeCode: { in: ['FM', 'FA'] } }),
      );
      expect(prisma.adminAccount.count).toHaveBeenCalledWith(
        partial({
          where: partial({ roleTypeCode: { in: ['FM', 'FA'] } }),
        }),
      );
    });

    it('역할을 비워 보내면 세 역할 모두', async () => {
      await service.list(2, bp, { page: 1, pageSize: 20, roleTypeCodes: [] });
      expect(whereOf()).toEqual(
        partial({ roleTypeCode: { in: ['BA', 'FM', 'FA'] } }),
      );
    });

    it('점포 수는 살아 있는 매핑만 센다 — _count 에는 where 만 (select 를 넣으면 Prisma 가 거부한다)', async () => {
      await service.list(2, bp, { page: 1, pageSize: 20 });
      const { select } = argOf<{ select: Record<string, unknown> }>(
        prisma.adminAccount.findMany,
      );
      expect(select._count).toEqual({
        select: {
          storeMappings: {
            where: { isDeleted: false, store: { isDeleted: false } },
          },
        },
      });
    });

    it('가맹 쪽은 본인과, 매핑 점포가 겹치는 가맹 관리자만', async () => {
      await service.list(20, bp, { page: 1, pageSize: 20 });
      expect(whereOf()).toEqual(
        partial({
          AND: expect.arrayContaining([
            {
              OR: [
                { adminAccountId: 20 },
                {
                  roleTypeCode: 'FA',
                  storeMappings: {
                    some: {
                      storeId: { in: [5, 6, 7, 8] },
                      isDeleted: false,
                    },
                  },
                },
                // 연결 가맹 마스터는 자기 가맹 관리자를 점포와 관계없이 본다(점포 0곳이 된 계정 포함)
                {
                  roleTypeCode: 'FA',
                  roleGroup: { managerAdminAccountId: 20 },
                },
              ],
            },
          ]) as unknown,
        }),
      );
    });

    it('가맹 관리자 호출자에게는 연결 가맹 마스터 갈래를 더하지 않는다', async () => {
      await service.list(30, bp, { page: 1, pageSize: 20 });
      const and = whereOf().AND as { OR?: unknown[] }[];
      expect(and[0].OR).toHaveLength(2);
    });

    it('점포 검색은 그 점포가 매핑된 계정과 전체 점포 계정', async () => {
      await service.list(2, bp, { page: 1, pageSize: 20, storeIds: [5] });
      expect(whereOf()).toEqual(
        partial({
          AND: expect.arrayContaining([
            {
              OR: [
                { isAllStores: true },
                {
                  storeMappings: {
                    some: {
                      isDeleted: false,
                      store: {
                        isDeleted: false,
                        storeId: { in: [5] },
                      },
                    },
                  },
                },
              ],
            },
          ]) as unknown,
        }),
      );
    });

    it('응답은 상태 · 점포 수 · 권한 그룹을 담고 미사용 수를 따로 센다', async () => {
      prisma.adminAccount.findMany.mockResolvedValueOnce([
        { ...accounts[1], _count: { storeMappings: 2 } },
      ]);
      prisma.adminAccount.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);
      const res = await service.list(2, bp, { page: 1, pageSize: 20 });
      expect(res).toEqual({
        items: [
          partial({
            adminAccountId: 2,
            accountStatus: 'ACTIVE',
            roleTypeCode: 'BA',
            storeCount: 2,
            roleGroup: partial({ roleCode: 'BA000002' }),
          }),
        ],
        total: 1,
        inactiveCount: 0,
      });
    });
  });

  describe('storeOptions', () => {
    const ids = (r: { items: { storeId: number }[] }) =>
      r.items.map((i) => i.storeId);

    it('BP 관리자 후보는 호출자 점포 중 폐점만 빼고 — 가맹 마스터 담당은 보지 않는다', async () => {
      const r = await service.storeOptions(1, bp, { roleTypeCode: 'BA' });
      expect(ids(r)).toEqual([1, 2, 3, 5, 6, 7, 8]);
      expect(prisma.adminStoreMapping.findMany).not.toHaveBeenCalled();
      expect(r.items[0]).not.toHaveProperty('isSelectable');
    });

    it('가맹 마스터 후보는 폐점과 다른 사용 중 가맹 마스터 담당 점포를 뺀다', async () => {
      prisma.adminStoreMapping.findMany.mockResolvedValue([
        {
          storeId: 5,
          adminAccount: {
            adminAccountId: 20,
            loginId: 'user20',
            name: '사용자20',
          },
        },
      ]);
      const r = await service.storeOptions(1, bp, {
        roleTypeCode: 'FM',
        adminAccountId: 21,
      });
      expect(ids(r)).toEqual([1, 2, 3, 6, 7, 8]);
    });
  });

  describe('isEmailAvailable', () => {
    it('지우지 않은 사용 · 미사용 계정이 쓰는 이메일이면 false — 저장 409 와 같은 기준', async () => {
      await expect(service.isEmailAvailable('user2@whale.test')).resolves.toBe(
        false,
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        partial({
          where: {
            email: 'user2@whale.test',
            isDeleted: false,
            accountStatusCode: { not: 'WITHDRAWN' },
          },
        }),
      );
    });

    it('아무도 쓰지 않으면 true', async () => {
      await expect(service.isEmailAvailable('new@whale.test')).resolves.toBe(
        true,
      );
    });
  });

  describe('detail', () => {
    it('본사는 가맹 관리자 상세를 보되 고치지 못하고, 연결 가맹 마스터를 함께 받는다', async () => {
      const res = await service.detail(1, bp, 30);
      expect(res.franchiseMaster).toEqual(
        partial({ adminAccountId: 20, loginId: 'user20' }),
      );
      expect(res.actions.canUpdate).toBe(false);
      expect(res.stores.map((s) => s.storeId)).toEqual([6, 7]);
    });

    it('가맹 마스터에게 BP 관리자 계정은 없는 것과 같다 — 404', async () => {
      await expect(service.detail(20, bp, 2)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('BP 마스터 계정은 이 화면의 대상이 아니다 — 404', async () => {
      await expect(service.detail(2, bp, 1)).rejects.toThrow(NotFoundException);
    });

    it('보는 사람의 범위 밖 매핑 점포를 표시한다', async () => {
      const res = await service.detail(2, bp, 40);
      expect(res.stores.map((s) => [s.storeId, s.isOutOfScope])).toEqual([
        [1, false],
        [5, true],
      ]);
    });
  });

  describe('create', () => {
    const input = (o: Record<string, unknown> = {}) => ({
      loginId: 'newuser1',
      name: '새사람',
      phone: '01099998888',
      email: 'New@Whale.test',
      roleTypeCode: 'BA' as const,
      roleGroupId: 11,
      isAllStores: false,
      storeIds: [1],
      ...o,
    });

    it('가맹 마스터가 BP 관리자를 만들려 하면 403', async () => {
      await expect(service.create(20, bp, input())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('가맹 관리자는 아무것도 만들지 못한다 — 403', async () => {
      await expect(
        service.create(
          30,
          bp,
          input({ roleTypeCode: 'FA', roleGroupId: 14, storeIds: [6] }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('가맹 관리자에게는 연결 가맹 마스터의 FA 그룹만 — 다른 마스터 그룹은 400', async () => {
      await expect(
        service.create(
          20,
          bp,
          input({ roleTypeCode: 'FA', roleGroupId: 15, storeIds: [6] }),
        ),
      ).rejects.toThrow('선택할 수 없는 권한입니다.');
    });

    it('가맹 마스터는 고정 권한(FM000001)만 — BA 그룹을 주면 400', async () => {
      await expect(
        service.create(
          1,
          bp,
          input({ roleTypeCode: 'FM', roleGroupId: 11, storeIds: [5] }),
        ),
      ).rejects.toThrow('선택할 수 없는 권한입니다.');
    });

    it('다른 사용 중 가맹 마스터가 맡은 점포를 가맹 마스터에게 주면 409', async () => {
      prisma.adminStoreMapping.findMany.mockResolvedValueOnce([
        { storeId: 5, adminAccount: { loginId: 'user20' } },
      ]);
      await expect(
        service.create(
          1,
          bp,
          input({ roleTypeCode: 'FM', roleGroupId: 13, storeIds: [5] }),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('가맹 관리자 점포는 연결 가맹 마스터의 점포 안 — 밖이면 400', async () => {
      await expect(
        service.create(
          20,
          bp,
          input({ roleTypeCode: 'FA', roleGroupId: 14, storeIds: [1] }),
        ),
      ).rejects.toThrow('점포 범위를 벗어나 저장하지 않았습니다.');
    });

    it('가맹 관리자 등록은 연결 가맹 마스터 행을 잠근 뒤 다시 읽는다 — 그사이 본사가 뺀 점포면 400, 계정은 없다', async () => {
      // 20(5~8)이 잠금을 기다리는 사이 본사가 20 에서 6 을 빼고 커밋했다
      whileLocked(masterRow, () => {
        patchAccount(20, {
          storeMappings: [{ storeId: 5 }, { storeId: 7 }, { storeId: 8 }],
        });
      });
      await expect(
        service.create(
          20,
          bp,
          input({ roleTypeCode: 'FA', roleGroupId: 14, storeIds: [6] }),
        ),
      ).rejects.toThrow('점포 범위를 벗어나 저장하지 않았습니다.');
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('가맹 관리자 등록 중 연결 가맹 마스터가 미사용이 됐으면 403 — 미사용 마스터 아래 사용 중 계정이 생기지 않는다', async () => {
      whileLocked(masterRow, () => {
        patchAccount(20, { accountStatusCode: 'INACTIVE' });
      });
      await expect(
        service.create(
          20,
          bp,
          input({ roleTypeCode: 'FA', roleGroupId: 14, storeIds: [6] }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('트랜잭션의 첫 문장으로 대상 BP 행을 FOR SHARE 로 잠근다 — 가맹 마스터 · 권한 그룹보다 먼저', async () => {
      await service.create(
        20,
        bp,
        input({ roleTypeCode: 'FA', roleGroupId: 14, storeIds: [6] }),
      );
      expect(firstInTx()).toMatch(bpRow);
    });

    it('잠그는 사이 BP 가 지워졌으면 404, 계정은 없다', async () => {
      whileLocked(bpRow, () => [{ ...liveBp, is_deleted: true }]);
      await expect(service.create(2, bp, input())).rejects.toThrow(
        new NotFoundException('BP 를 찾을 수 없습니다.'),
      );
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('BP 가 미사용이면 409 — 미사용 BP 아래 사용 계정을 만들지 않는다', async () => {
      whileLocked(bpRow, () => [
        { ...liveBp, account_status_code: 'INACTIVE' },
      ]);
      await expect(service.create(2, bp, input())).rejects.toThrow(
        new ConflictException(
          'BP 가 사용 중이 아니라 사용 계정을 둘 수 없습니다.',
        ),
      );
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('BP 가 탈퇴여도 409 — 사용 중이 아닌 BP 는 모두 막는다', async () => {
      whileLocked(bpRow, () => [
        { ...liveBp, account_status_code: 'WITHDRAWN' },
      ]);
      await expect(service.create(2, bp, input())).rejects.toThrow(
        new ConflictException(
          'BP 가 사용 중이 아니라 사용 계정을 둘 수 없습니다.',
        ),
      );
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('잠글 BP 행이 없으면 404', async () => {
      whileLocked(bpRow, () => []);
      await expect(service.create(2, bp, input())).rejects.toThrow(
        new NotFoundException('BP 를 찾을 수 없습니다.'),
      );
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('잠그는 BP 는 호출자의 BP 가 아니라 대상 BP 다', async () => {
      await service.create(2, bp, input());
      const lock = (
        prisma.$queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][]
      ).find(([sql]) => bpRow.test(sql.join('?')));
      expect(lock?.slice(1)).toEqual([bp.bpCodeId]);
    });

    it('BP 잠금을 기다리다 트랜잭션 시간을 넘기면 503 — 다시 시도할 일이다', async () => {
      whileLocked(bpRow, () => {
        throw txTimeout();
      });
      await expect(service.create(2, bp, input())).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('고른 권한 그룹을 잠그고 다시 본다 — 그사이 지워졌으면 400, 계정은 없다', async () => {
      whileLocked(groupRow, () => []);
      await expect(service.create(2, bp, input())).rejects.toThrow(
        '선택할 수 없는 권한입니다.',
      );
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('폐점 점포를 맡기면 400', async () => {
      await expect(
        service.create(1, bp, input({ storeIds: [4] })),
      ).rejects.toThrow('폐점한 점포는 새로 맡길 수 없습니다.');
    });

    it('아이디가 이미 있으면(삭제 · 탈퇴 포함) 409', async () => {
      await expect(
        service.create(1, bp, input({ loginId: 'user30' })),
      ).rejects.toThrow(ConflictException);
    });

    it('만들면 미발송 · 플랫폼등록으로 쓰고 매핑 · 이력 · 임시 비밀번호를 남긴 뒤 메일을 보낸다', async () => {
      const res = await service.create(2, bp, input());
      expect(res).toEqual({ adminAccountId: 50, isMailSent: true });
      expect(prisma.adminAccount.create).toHaveBeenCalledWith(
        partial({
          data: partial({
            loginId: 'newuser1',
            email: 'new@whale.test',
            bpCodeId: BP,
            roleTypeCode: 'BA',
            roleGroupId: 11,
            isAllStores: false,
            passwordHash: '!',
            isPasswordChangeRequired: true,
            isInitialPasswordUnsent: true,
            joinPathCode: 'PLATFORM_REGISTERED',
            accountStatusCode: 'ACTIVE',
            createdBy: 2,
          }),
        }),
      );
      expect(prisma.adminStoreMapping.createMany).toHaveBeenCalledWith(
        partial({
          data: [partial({ adminAccountId: 50, storeId: 1, createdBy: 2 })],
        }),
      );
      expect(prisma.temporaryPassword.create).toHaveBeenCalledWith(
        partial({ data: partial({ purpose: 'INITIAL' }) }),
      );
      expect(mail.send).toHaveBeenCalledWith(
        partial({
          templateCode: 'EMAIL_BP_ADMIN_CREATE',
          to: 'new@whale.test',
          variables: partial({
            관리자이름: '새사람',
            BP이름: '모리커피',
            로그인아이디: 'newuser1',
          }),
          maskedVariables: ['임시비밀번호'],
        }),
      );
    });

    it('메일이 실패해도 계정은 남고 isMailSent false', async () => {
      mail.send.mockRejectedValueOnce(new Error('smtp'));
      const res = await service.create(2, bp, input());
      expect(res).toEqual({ adminAccountId: 50, isMailSent: false });
    });

    it('메일에 쓸 BP 상호명은 커밋 전에 읽는다 — 그 조회가 실패하면 계정을 만들지 않는다', async () => {
      // 커밋 뒤에 실패하면 계정은 생겼는데 500 이라, 화면이 다시 등록해 아이디 409 를 받는다.
      prisma.bpCode.findFirst.mockRejectedValueOnce(new Error('db'));
      await expect(service.create(2, bp, input())).rejects.toThrow('db');
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('확인과 INSERT 사이에 아이디 · 이메일을 먼저 가져가면 409', async () => {
      prisma.adminAccount.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      await expect(service.create(2, bp, input())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    const input = (id: number, o: Record<string, unknown> = {}) => {
      const a = accounts.find((x) => x.adminAccountId === id)!;
      return {
        name: a.name,
        phone: a.phone,
        email: a.email,
        roleGroupId: a.roleGroupId,
        isAllStores: a.isAllStores,
        storeIds: a.storeMappings.map((m) => m.storeId),
        accountStatus: 'ACTIVE' as const,
        updatedAt: updatedAt.toISOString(),
        ...o,
      };
    };

    it('가맹 관리자 수정은 연결 가맹 마스터 행을 잠근 뒤 다시 읽는다 — 그사이 본사가 뺀 점포를 더하면 400', async () => {
      // 30(6 · 7)에 5 를 더하려는데, 잠금을 기다리는 사이 본사가 20 에서 5 를 뺐다
      whileLocked(masterRow, () => {
        patchAccount(20, {
          storeMappings: [{ storeId: 6 }, { storeId: 7 }, { storeId: 8 }],
        });
      });
      await expect(
        service.update(20, bp, 30, input(30, { storeIds: [5, 6, 7] })),
      ).rejects.toThrow('점포 범위를 벗어나 저장하지 않았습니다.');
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('트랜잭션의 첫 문장으로 대상 BP 행을 FOR SHARE 로 잠근다 — 대상 계정을 읽기 전에', async () => {
      await service.update(1, bp, 2, input(2, { name: '새이름' }));
      expect(firstInTx()).toMatch(bpRow);
    });

    it('잠그는 사이 BP 가 지워졌으면 404', async () => {
      whileLocked(bpRow, () => [{ ...liveBp, is_deleted: true }]);
      await expect(
        service.update(1, bp, 2, input(2, { accountStatus: 'INACTIVE' })),
      ).rejects.toThrow(new NotFoundException('BP 를 찾을 수 없습니다.'));
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('미사용 BP 에서 사용으로 저장하면 409 — 다시 사용으로 돌리는 것도 막는다', async () => {
      patchAccount(2, { accountStatusCode: 'INACTIVE' });
      whileLocked(bpRow, () => [
        { ...liveBp, account_status_code: 'INACTIVE' },
      ]);
      await expect(
        service.update(1, bp, 2, input(2, { accountStatus: 'ACTIVE' })),
      ).rejects.toThrow(
        new ConflictException(
          'BP 가 사용 중이 아니라 사용 계정을 둘 수 없습니다.',
        ),
      );
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('미사용 BP 의 미사용 계정은 미사용 그대로 고칠 수 있다', async () => {
      patchAccount(2, { accountStatusCode: 'INACTIVE' });
      whileLocked(bpRow, () => [
        { ...liveBp, account_status_code: 'INACTIVE' },
      ]);
      await service.update(
        1,
        bp,
        2,
        input(2, { name: '새이름', accountStatus: 'INACTIVE' }),
      );
      expect(prisma.adminAccount.updateMany).toHaveBeenCalled();
    });

    it('미사용 BP 의 사용 계정을 미사용으로 저장하는 것은 된다 — BP 상태를 묻지 않는다', async () => {
      whileLocked(bpRow, () => [
        { ...liveBp, account_status_code: 'INACTIVE' },
      ]);
      await service.update(1, bp, 2, input(2, { accountStatus: 'INACTIVE' }));
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith(
        partial({ data: partial({ accountStatusCode: 'INACTIVE' }) }),
      );
    });

    it('BP 잠금을 기다리다 트랜잭션 시간을 넘기면 503', async () => {
      whileLocked(bpRow, () => {
        throw txTimeout();
      });
      await expect(
        service.update(1, bp, 2, input(2, { name: '새이름' })),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('권한 그룹을 바꿀 때 그 그룹을 잠그고 다시 본다 — 그사이 지워졌으면 400', async () => {
      whileLocked(groupRow, () => []);
      await expect(
        service.update(1, bp, 2, input(2, { roleGroupId: 12 })),
      ).rejects.toThrow('선택할 수 없는 권한입니다.');
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('본사가 가맹 관리자를 고치려 하면 403', async () => {
      await expect(service.update(1, bp, 30, input(30))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('본인 계정의 상태를 바꾸려 하면 403', async () => {
      await expect(
        service.update(2, bp, 2, input(2, { accountStatus: 'INACTIVE' })),
      ).rejects.toThrow(ForbiddenException);
    });

    it('그 사이 다른 사람이 고쳤으면 409', async () => {
      prisma.adminAccount.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.update(1, bp, 2, input(2, { name: '새이름' })),
      ).rejects.toThrow(ConflictException);
    });

    it('바뀐 항목만 이력에 남긴다', async () => {
      await service.update(1, bp, 2, input(2, { name: '새이름' }));
      expect(historyRows()).toEqual([
        partial({
          adminAccountId: 2,
          field: '이름',
          beforeValue: '사용자2',
          afterValue: '새이름',
          changedBy: 1,
        }),
      ]);
    });

    it('범위 밖 매핑은 남긴다 — 일부 점포 담당이 범위 안 점포만 바꾼다', async () => {
      // 2(점포 1 · 2 담당)가 40(1 · 5)을 고쳐 1 을 빼고 2 를 더한다
      await service.update(2, bp, 40, input(40, { storeIds: [2] }));
      expect(prisma.adminStoreMapping.updateMany).toHaveBeenCalledWith(
        partial({
          where: partial({ adminAccountId: 40, storeId: { in: [1] } }),
          data: partial({ isDeleted: true }),
        }),
      );
      expect(prisma.adminStoreMapping.createMany).toHaveBeenCalledWith(
        partial({ data: [partial({ adminAccountId: 40, storeId: 2 })] }),
      );
    });

    it('가맹 마스터를 미사용으로 바꾸면 연결된 사용 중 가맹 관리자도 미사용 — 처리자는 저장한 사람, 값에 이유', async () => {
      await service.update(1, bp, 20, input(20, { accountStatus: 'INACTIVE' }));
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith(
        partial({
          where: partial({ adminAccountId: { in: [30, 31] } }),
          data: partial({ accountStatusCode: 'INACTIVE', updatedBy: 1 }),
        }),
      );
      expect(historyRows()).toEqual(
        expect.arrayContaining([
          partial({
            adminAccountId: 30,
            field: '계정 상태',
            beforeValue: '사용',
            afterValue: '미사용 (가맹 마스터 미사용)',
            changedBy: 1,
          }),
        ]),
      );
    });

    it('가맹 마스터 점포를 빼면 연결 가맹 관리자의 그 점포 매핑도 빠진다 — 0곳이 되어도 상태는 그대로', async () => {
      // 20(5~8)에서 7 · 8 을 뺀다 — 30(6 · 7)은 7 을, 31(8)은 8 을 잃는다
      await service.update(1, bp, 20, input(20, { storeIds: [5, 6] }));
      expect(prisma.adminStoreMapping.updateMany).toHaveBeenCalledWith(
        partial({
          where: partial({ adminAccountId: 30, storeId: { in: [7] } }),
          data: partial({ isDeleted: true }),
        }),
      );
      expect(prisma.adminStoreMapping.updateMany).toHaveBeenCalledWith(
        partial({
          where: partial({ adminAccountId: 31, storeId: { in: [8] } }),
        }),
      );
      expect(historyRows()).toEqual(
        expect.arrayContaining([
          partial({
            adminAccountId: 31,
            field: '점포',
            beforeValue: '점포8',
            afterValue: '없음 (가맹 마스터 점포 제외)',
            changedBy: 1,
          }),
        ]),
      );
      // 가맹 관리자 상태는 건드리지 않되, 매핑이 바뀌었으니 수정자 · 수정일시는 올린다 — 상세의 최종 수정이 맞고,
      // 열어 둔 수정 화면의 저장이 낙관적 잠금(updatedAt)으로 409 가 된다(PR #160 리뷰).
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: { in: [30, 31] } },
        data: { updatedBy: 1 },
      });
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalledWith(
        partial({
          where: partial({ adminAccountId: { in: [30, 31] } }),
          data: partial({ accountStatusCode: expect.anything() as unknown }),
        }),
      );
    });

    it('가맹 마스터에게 다른 가맹 마스터가 맡은 점포를 더하면 409', async () => {
      prisma.adminStoreMapping.findMany.mockResolvedValueOnce([
        { storeId: 3, adminAccount: { loginId: 'user21' } },
      ]);
      await expect(
        service.update(1, bp, 20, input(20, { storeIds: [3, 5, 6, 7, 8] })),
      ).rejects.toThrow(ConflictException);
    });

    it('이메일이 다른 사용 · 미사용 계정과 겹치면 409', async () => {
      await expect(
        service.update(1, bp, 2, input(2, { email: 'user40@whale.test' })),
      ).rejects.toThrow(ConflictException);
    });

    it('이메일을 바꿔 임시 비밀번호를 막았으면, 쓸 수 있는 비밀번호가 없는 계정만 「미발송」을 켠다', async () => {
      prisma.temporaryPassword.updateMany.mockResolvedValue({ count: 1 });
      await service.update(1, bp, 2, input(2, { email: 'new2@whale.test' }));
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: 2, passwordHash: '!' },
        data: { isInitialPasswordUnsent: true },
      });
    });
  });

  describe('updateImpact', () => {
    it('미사용이 되는 가맹 관리자와 매핑이 빠지는 가맹 관리자를 센다', async () => {
      const res = await service.updateImpact(1, bp, 20, {
        accountStatus: 'INACTIVE',
        storeIds: [5, 6],
      });
      expect(res).toEqual({
        deactivatedCount: 2,
        firstDeactivatedLoginId: 'user30',
        unmappedCount: 2,
        firstUnmappedLoginId: 'user30',
      });
    });

    it('가맹 마스터가 아니면 400', async () => {
      await expect(
        service.updateImpact(1, bp, 2, {
          accountStatus: 'INACTIVE',
          storeIds: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resetPassword', () => {
    it('본인 계정은 403', async () => {
      await expect(service.resetPassword(2, bp, 2)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('미사용 계정도 초기화한다 — RESET 비밀번호를 내고 메일을 보낸다', async () => {
      accounts[1] = { ...accounts[1], accountStatusCode: 'INACTIVE' };
      const res = await service.resetPassword(1, bp, 2);
      expect(res.isMailSent).toBe(true);
      expect(prisma.temporaryPassword.create).toHaveBeenCalledWith(
        partial({ data: partial({ purpose: 'RESET' }) }),
      );
      expect(mail.send).toHaveBeenCalledWith(
        partial({ templateCode: 'EMAIL_PASSWORD_RESET' }),
      );
    });

    it('초기화 쓰기는 탈퇴 계정을 건드리지 않는다 — 읽은 뒤 탈퇴했으면 0건이라 409', async () => {
      await service.resetPassword(1, bp, 2);
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith(
        partial({
          where: partial({
            adminAccountId: 2,
            accountStatusCode: { not: 'WITHDRAWN' },
          }),
          data: partial({ passwordHash: '!' }),
        }),
      );
    });

    it('메일 설정이 없으면 아무것도 쓰지 않고 503', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          BpAdminsService,
          { provide: PrismaService, useValue: prisma },
          { provide: PLATFORM_ADMIN_MAIL, useValue: null },
        ],
      }).compile();
      await expect(
        moduleRef.get(BpAdminsService).resetPassword(1, bp, 2),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.temporaryPassword.create).not.toHaveBeenCalled();
    });
  });
});
