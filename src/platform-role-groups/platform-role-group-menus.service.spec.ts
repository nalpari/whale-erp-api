// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CodesService } from '../codes/codes.service';
import {
  type MenuCaller,
  MenuPermissionsService,
} from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformRoleGroupMenusService } from './platform-role-group-menus.service';

const PM: MenuCaller = {
  adminAccountId: 1,
  roleTypeCode: 'PM',
  roleGroupId: 1,
};
const PA: MenuCaller = {
  adminAccountId: 2,
  roleTypeCode: 'PA',
  roleGroupId: 2,
};
const UPDATED_AT = '2026-10-15T01:00:00.000Z';
const SAVED_AT = new Date('2026-10-15T02:00:00.000Z');

type Row = [menuId: number, r: boolean, c: boolean, u: boolean, d: boolean];
const rows = (...list: Row[]) =>
  list.map(([menuId, r, c, u, d]) => ({
    menuId,
    isReadable: r,
    isCreatable: c,
    isUpdatable: u,
    isDeletable: d,
  }));
const cells = (
  menuId: number,
  r: boolean,
  c = false,
  u = false,
  d = false,
) => ({
  menuId,
  read: r,
  create: c,
  update: u,
  delete: d,
});

/**
 * 메뉴 표본. PLATFORM: 10 시스템관리(묶음) ─ 11 플랫폼 관리자 관리 · 12 플랫폼 권한 관리, 13 사용중지 메뉴,
 * 14 사용중지 묶음 ─ 15 (사용 중이지만 상위가 사용중지). WHALE_ERP: 20 직원관리(묶음) ─ 21 직원 정보 · 22 근무스케줄.
 * POS: 30 (사용중지 서비스).
 */
const MENUS = [
  [10, null, 'MN000212', 'PLATFORM', '시스템관리', 1, 'ACTIVE'],
  [11, 10, 'MN000213', 'PLATFORM', '플랫폼 관리자 관리', 2, 'ACTIVE'],
  [12, 10, 'MN000214', 'PLATFORM', '플랫폼 권한 관리', 2, 'ACTIVE'],
  [13, null, 'MN000201', 'PLATFORM', '회원관리', 1, 'INACTIVE'],
  [14, null, 'MN000204', 'PLATFORM', '서비스정산관리', 1, 'INACTIVE'],
  [15, 14, 'MN000205', 'PLATFORM', '부가서비스 주문 내역', 2, 'ACTIVE'],
  [20, null, 'MN000004', 'WHALE_ERP', '직원관리', 1, 'ACTIVE'],
  [21, 20, 'MN000005', 'WHALE_ERP', '직원 정보 관리', 2, 'ACTIVE'],
  [22, 20, 'MN000010', 'WHALE_ERP', '근무스케줄 관리', 2, 'ACTIVE'],
  [30, null, 'MN000301', 'POS', 'POS 메뉴', 1, 'ACTIVE'],
].map(([menuId, parentMenuId, menuCode, serviceCode, name, depth, status]) => ({
  menuId,
  parentMenuId,
  menuCode,
  serviceCode,
  name,
  depth,
  sortOrder: menuId as number,
  status,
}));

const TARGETS: Record<number, object> = {
  1: {
    roleGroupId: 1,
    roleCode: 'PM000001',
    roleTypeCode: 'PM',
    name: '플랫폼 마스터',
    isMaster: true,
  },
  // PA 고정 권한은 시드되지 않는다 — 생긴다면(is_master)의 가정이라 시드처럼 보이지 않는 코드를 쓴다.
  2: {
    roleGroupId: 2,
    roleCode: 'PA900000',
    roleTypeCode: 'PA',
    name: '플랫폼 관리자(가정)',
    isMaster: true,
  },
  3: {
    roleGroupId: 3,
    roleCode: 'BM000001',
    roleTypeCode: 'BM',
    name: 'BP 마스터',
    isMaster: true,
  },
  5: {
    roleGroupId: 5,
    roleCode: 'PA000002',
    roleTypeCode: 'PA',
    name: '고객지원 담당',
    isMaster: false,
  },
};

describe('PlatformRoleGroupMenusService', () => {
  let service: PlatformRoleGroupMenusService;
  let prisma: Record<string, any>;
  /** 호출자는 id 로 읽는다 — PM(1) · PA(2). */
  let permissions: { caller: jest.Mock };
  let tx: Record<string, any>;
  let codes: { forBp: jest.Mock };
  /** 그룹별 현재 메뉴 행 */
  let grants: Record<number, ReturnType<typeof rows>>;
  /** 회수 연쇄가 찾는 BA · FA 그룹의 행 */
  let childRows: (ReturnType<typeof rows>[number] & { roleGroupId: number })[];

  const grantsFind = ({ where }: { where: Record<string, any> }) =>
    Promise.resolve(
      where.roleGroupId !== undefined
        ? (grants[where.roleGroupId] ?? [])
        : childRows.filter((r) => where.menuId.in.includes(r.menuId)),
    );

  beforeEach(async () => {
    permissions = {
      caller: jest.fn((id: number) =>
        Promise.resolve([PM, PA].find((c) => c.adminAccountId === id)),
      ),
    };
    grants = {
      // PM 호출자 — 전부. PA 호출자(그룹 2) — 시스템관리 · 관리자 관리 RCU · 권한 관리 RCU · 직원 정보 R.
      1: rows(
        [10, true, false, false, false],
        [11, true, true, true, true],
        [12, true, true, true, true],
      ),
      2: rows(
        [10, true, false, false, false],
        [11, true, true, true, false],
        [12, true, true, true, false],
        [20, true, false, false, false],
        [21, true, false, false, false],
      ),
      3: rows(
        [20, true, false, false, false],
        [21, true, true, true, true],
        [22, true, true, true, true],
      ),
      5: rows(
        [10, true, false, false, false],
        [11, true, false, false, false],
        [15, true, false, false, false],
      ),
    };
    childRows = [];
    codes = {
      forBp: jest.fn().mockResolvedValue({
        SERVICE: [
          { value: 'PLATFORM', label: 'Whale ERP 플랫폼 관리', order: 1 },
          { value: 'WHALE_ERP', label: 'Whale ERP', order: 2 },
        ],
      }),
    };
    prisma = {
      menu: { findMany: jest.fn().mockResolvedValue(MENUS) },
      roleGroup: {
        findFirst: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve(
            TARGETS[where.roleGroupId]
              ? {
                  ...TARGETS[where.roleGroupId],
                  description: null,
                  updatedAt: new Date(UPDATED_AT),
                }
              : null,
          ),
        ),
      },
      roleGroupMenu: { findMany: jest.fn().mockImplementation(grantsFind) },
      adminAccount: { count: jest.fn().mockResolvedValue(0) },
    };
    tx = {
      roleGroup: {
        findFirst: prisma.roleGroup.findFirst,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ updatedAt: SAVED_AT }),
      },
      roleGroupMenu: {
        findMany: jest.fn().mockImplementation(grantsFind),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction = jest.fn((fn: (t: unknown) => unknown) => fn(tx));
    const module = await Test.createTestingModule({
      providers: [
        PlatformRoleGroupMenusService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodesService, useValue: codes },
        { provide: MenuPermissionsService, useValue: permissions },
      ],
    }).compile();
    service = module.get(PlatformRoleGroupMenusService);
  });

  /** 트리를 메뉴 id → 노드로 편다. */
  function flat(tree: Awaited<ReturnType<typeof service.tree>>) {
    const out = new Map<number, any>();
    const walk = (nodes: any[]) =>
      nodes.forEach((n) => {
        out.set(n.menuId, n);
        walk(n.children);
      });
    tree.services.forEach((s) => walk(s.menus));
    return out;
  }

  describe('호출자', () => {
    it.each([
      ['tree', () => service.tree(PA.adminAccountId, 5)],
      [
        'save',
        () =>
          service.save(PA.adminAccountId, 5, {
            menus: [],
            updatedAt: UPDATED_AT,
          }),
      ],
      ['preview', () => service.preview(PA.adminAccountId, 5, { menus: [] })],
    ] as const)('%s 는 받은 관리자 id 로 호출자를 읽는다', async (_, call) => {
      await call();
      expect(permissions.caller).toHaveBeenCalledWith(PA.adminAccountId);
    });

    it('계정을 쓸 수 없으면 caller 의 403 을 그대로 내고 쓰지 않는다', async () => {
      permissions.caller.mockRejectedValue(new ForbiddenException('x'));
      await expect(
        service.save(PA.adminAccountId, 5, {
          menus: [],
          updatedAt: UPDATED_AT,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('tree', () => {
    it('사용 중 서비스 순서로 숨긴 메뉴를 빼고 트리를 만든다 — 값은 대상 그룹의 현재 칸', async () => {
      const tree = await service.tree(PM.adminAccountId, 5);
      expect(codes.forBp).toHaveBeenCalledWith('BP000000');
      expect(tree.services.map((s) => [s.serviceCode, s.name])).toEqual([
        ['PLATFORM', 'Whale ERP 플랫폼 관리'],
        ['WHALE_ERP', 'Whale ERP'],
      ]);
      const nodes = flat(tree);
      expect([...nodes.keys()]).toEqual([10, 11, 12, 20, 21, 22]);
      expect(tree.services[0].menus.map((m) => m.menuId)).toEqual([10]);
      expect(nodes.get(10)).toMatchObject({
        isGroup: true,
        menuCode: 'MN000212',
        depth: 1,
      });
      expect(nodes.get(11).read).toEqual({
        value: true,
        editable: true,
        blockedReason: null,
      });
      expect(nodes.get(11).create).toEqual({
        value: false,
        editable: true,
        blockedReason: null,
      });
      expect(tree).toMatchObject({
        roleGroupId: 5,
        roleCode: 'PA000002',
        isSavable: true,
        updatedAt: new Date(UPDATED_AT),
      });
      // 지운 메뉴는 처음부터 읽지 않는다.
      expect(prisma.menu.findMany.mock.calls[0][0].where).toEqual({
        isDeleted: false,
      });
    });

    it('플랫폼 마스터는 전부 허용 · 읽기 전용으로 보인다 — 묶음은 조회만', async () => {
      const tree = await service.tree(PA.adminAccountId, 1);
      const nodes = flat(tree);
      expect(nodes.get(22).delete).toEqual({
        value: true,
        editable: false,
        blockedReason: 'PM_FIXED',
      });
      expect(nodes.get(20).read.value).toBe(true);
      expect(nodes.get(20).create.value).toBe(false);
      expect(tree.isSavable).toBe(false);
    });

    it('호출자에게 권한 관리 수정 권한이 없으면 READ_ONLY', async () => {
      grants[2] = rows([12, true, false, false, false]);
      const tree = await service.tree(PA.adminAccountId, 5);
      expect(flat(tree).get(11).read.blockedReason).toBe('READ_ONLY');
      expect(tree.isSavable).toBe(false);
    });

    it('본인이 연결된 권한이면 SELF_LINKED', async () => {
      const tree = await service.tree(PA.adminAccountId, 2);
      expect(flat(tree).get(11).read.blockedReason).toBe('SELF_LINKED');
      expect(tree.isSavable).toBe(false);
    });

    it('BP 마스터에 잘못 켜진 플랫폼 메뉴 칸은 끌 수 있게 열리고, 꺼진 칸은 막힌다', async () => {
      grants[3] = [...grants[3], ...rows([11, true, false, false, false])];
      const nodes = flat(await service.tree(PM.adminAccountId, 3));
      expect(nodes.get(11).read).toEqual({
        value: true,
        editable: true,
        blockedReason: null,
      });
      expect(nodes.get(11).create.blockedReason).toBe('PLATFORM_MENU_FOR_BP');
    });

    it('BP 마스터에는 플랫폼 메뉴가 막히고, ERP 메뉴는 PA 호출자여도 상한 없이 열린다', async () => {
      const nodes = flat(await service.tree(PA.adminAccountId, 3));
      expect(nodes.get(11).read.blockedReason).toBe('PLATFORM_MENU_FOR_BP');
      expect(nodes.get(10).read.blockedReason).toBe('PLATFORM_MENU_FOR_BP');
      expect(nodes.get(22).delete).toEqual({
        value: true,
        editable: true,
        blockedReason: null,
      });
    });

    it('PA 호출자가 PA 권한을 보면 본인에게 없는 칸은 OUT_OF_SCOPE — 묶음은 열린 하위가 있으면 열린다', async () => {
      const nodes = flat(await service.tree(PA.adminAccountId, 5));
      expect(nodes.get(11).create.blockedReason).toBeNull();
      expect(nodes.get(11).delete.blockedReason).toBe('OUT_OF_SCOPE');
      expect(nodes.get(22).read.blockedReason).toBe('OUT_OF_SCOPE');
      expect(nodes.get(20).read.blockedReason).toBeNull(); // 21 의 조회가 열려 있다
      expect(nodes.get(20).create.blockedReason).toBe('OUT_OF_SCOPE');
    });

    it('묶음 칸은 자기 칸이 상한 밖이어도 열린 하위가 있으면 열린다', async () => {
      grants[2] = grants[2].filter((r) => r.menuId !== 10); // 호출자에게 묶음 10 의 행이 없다
      const nodes = flat(await service.tree(PA.adminAccountId, 5));
      expect(nodes.get(10).read.blockedReason).toBeNull(); // 11 · 12 의 조회가 열려 있다
    });

    it('켜진 조회 칸은 같은 줄의 켜진 칸 중 상한 밖이 있으면 OUT_OF_SCOPE — 끄면 저장이 400 이므로', async () => {
      grants[5] = rows([11, true, false, false, true]); // 호출자에게 11 삭제가 없다
      expect(
        flat(await service.tree(PA.adminAccountId, 5)).get(11).read
          .blockedReason,
      ).toBe('OUT_OF_SCOPE');
      grants[5] = rows([11, true, true, false, false]); // 등록은 호출자에게 있다
      expect(
        flat(await service.tree(PA.adminAccountId, 5)).get(11).read
          .blockedReason,
      ).toBeNull();
    });

    it('PM 호출자에게는 상한이 없다', async () => {
      const nodes = flat(await service.tree(PM.adminAccountId, 5));
      expect(nodes.get(22).delete.blockedReason).toBeNull();
    });

    it('공통코드 SERVICE 가 없으면 빈 트리가 아니라 원인을 적은 500', async () => {
      codes.forBp.mockResolvedValue({});
      await expect(service.tree(PM.adminAccountId, 5)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('없는 그룹은 404', async () => {
      await expect(service.tree(PM.adminAccountId, 99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('save', () => {
    const save = (caller: MenuCaller, id: number, menus: object[]) =>
      service.save(caller.adminAccountId, id, {
        menus: menus as never,
        updatedAt: UPDATED_AT,
      });

    it('바뀐 메뉴만 트랜잭션 안에서 행을 만들거나 고치고 새 updatedAt 을 준다', async () => {
      const result = await save(PM, 5, [
        cells(11, true, true), // 조회 → 조회·등록
        cells(12, true), // 없음 → 조회
        cells(10, false, true, true, true), // 묶음 — 무시하고 하위에서 다시 정한다
      ]);
      expect(result).toEqual({ updatedAt: SAVED_AT });
      expect(tx.roleGroup.updateMany).toHaveBeenCalledWith({
        where: {
          roleGroupId: 5,
          isDeleted: false,
          updatedAt: {
            gte: new Date(UPDATED_AT),
            lt: new Date(new Date(UPDATED_AT).getTime() + 1),
          },
        },
        data: { updatedBy: PM.adminAccountId },
      });
      // 잠금(updateMany) 뒤에 현재 값을 읽는다.
      expect(tx.roleGroup.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        tx.roleGroupMenu.findMany.mock.invocationCallOrder[0],
      );
      const upserts = tx.roleGroupMenu.upsert.mock.calls.map(([a]) => a);
      expect(upserts.map((u) => u.where.roleGroupId_menuId.menuId)).toEqual([
        11, 12,
      ]);
      expect(upserts[1]).toEqual({
        where: { roleGroupId_menuId: { roleGroupId: 5, menuId: 12 } },
        create: {
          roleGroupId: 5,
          menuId: 12,
          isReadable: true,
          isCreatable: false,
          isUpdatable: false,
          isDeletable: false,
          createdBy: PM.adminAccountId,
          updatedBy: PM.adminAccountId,
        },
        update: {
          isReadable: true,
          isCreatable: false,
          isUpdatable: false,
          isDeletable: false,
          isDeleted: false,
          updatedBy: PM.adminAccountId,
        },
      });
      expect(prisma.roleGroupMenu.upsert).toBeUndefined();
    });

    it('모두 끄면 행을 지우지 않고 네 칸을 false 로 둔다. 보내지 않은 메뉴와 숨긴 메뉴의 행은 그대로', async () => {
      await save(PM, 5, [cells(11, false)]);
      const upserts = tx.roleGroupMenu.upsert.mock.calls.map(([a]) => a);
      // 11 이 꺼져 묶음 10 의 조회도 꺼진다. 숨긴 15 는 건드리지 않는다.
      expect(upserts.map((u) => u.where.roleGroupId_menuId.menuId)).toEqual([
        10, 11,
      ]);
      expect(upserts[1].update).toMatchObject({
        isReadable: false,
        isDeleted: false,
      });
    });

    it('묶음 메뉴는 하위에 조회가 있으면 조회만 켜진다', async () => {
      await save(PM, 5, [cells(21, true)]);
      const upserts = tx.roleGroupMenu.upsert.mock.calls.map(([a]) => a);
      expect(
        upserts.map((u) => [
          u.where.roleGroupId_menuId.menuId,
          u.update.isReadable,
          u.update.isCreatable,
        ]),
      ).toEqual([
        [20, true, false],
        [21, true, false],
      ]);
    });

    it('등록 · 수정 · 삭제가 켜졌는데 조회가 꺼진 줄은 400', async () => {
      await expect(
        save(PM, 5, [cells(11, false, true)]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['사용중지 메뉴', 13],
      ['사용중지 상위 아래', 15],
      ['사용중지 서비스', 30],
      ['없거나 지운 메뉴', 999],
    ])(
      '숨긴 메뉴(%s)를 보내면 400 — 아무것도 쓰지 않는다',
      async (_, menuId) => {
        await expect(save(PM, 5, [cells(menuId, true)])).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('같은 메뉴를 두 번 보내면 400', async () => {
      await expect(
        save(PM, 5, [cells(11, true), cells(11, false)]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('플랫폼 마스터 권한은 409, 본인 연결은 403, 없는 그룹은 404', async () => {
      await expect(save(PA, 1, [])).rejects.toBeInstanceOf(ConflictException);
      await expect(save(PA, 2, [])).rejects.toThrow(
        new ForbiddenException('본인이 연결된 권한이라 고칠 수 없습니다'),
      );
      await expect(save(PM, 99, [])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('그 사이 다른 사람이 저장했으면 409 — 행을 쓰지 않는다', async () => {
      tx.roleGroup.updateMany.mockResolvedValue({ count: 0 });
      await expect(save(PM, 5, [cells(12, true)])).rejects.toThrow(
        new ConflictException(
          '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요',
        ),
      );
      expect(tx.roleGroupMenu.upsert).not.toHaveBeenCalled();
    });

    it('그 사이 그룹이 지워졌으면 409 가 아니라 404', async () => {
      tx.roleGroup.updateMany.mockResolvedValue({ count: 0 });
      tx.roleGroup.findFirst = jest.fn().mockResolvedValue(null);
      await expect(save(PM, 5, [cells(12, true)])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('BP 마스터에 플랫폼 메뉴를 켜면 400', async () => {
      await expect(save(PM, 3, [cells(11, true)])).rejects.toThrow(
        new BadRequestException(
          'BP 마스터·가맹 마스터 권한에는 플랫폼 관리 메뉴를 줄 수 없습니다',
        ),
      );
      expect(tx.roleGroupMenu.upsert).not.toHaveBeenCalled();
    });

    describe('본인 범위 상한(PA 호출자 → PA 쪽 권한)', () => {
      it('본인에게 있는 칸은 켤 수 있다', async () => {
        await save(PA, 5, [cells(11, true, true, true)]);
        expect(tx.roleGroupMenu.upsert).toHaveBeenCalled();
      });

      it('본인에게 없는 칸을 켜면 400', async () => {
        await expect(
          save(PA, 5, [cells(11, true, false, false, true)]),
        ).rejects.toThrow(
          new BadRequestException('본인 권한 범위 밖 칸은 바꿀 수 없습니다'),
        );
        expect(tx.roleGroupMenu.upsert).not.toHaveBeenCalled();
      });

      it('본인에게 없는 칸을 끄는 것도 400', async () => {
        grants[5] = rows(
          [20, true, false, false, false],
          [22, true, false, false, false],
        );
        await expect(save(PA, 5, [cells(22, false)])).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('조회를 끄면 같은 줄의 켜진 칸도 꺼지므로, 그중 본인에게 없는 칸이 있으면 400', async () => {
        grants[5] = rows([11, true, false, false, true]); // 호출자는 11 에 삭제가 없다
        await expect(
          save(PA, 5, [cells(11, false)]), // 조회 · 삭제를 함께 끈다
        ).rejects.toThrow(
          new BadRequestException('본인 권한 범위 밖 칸은 바꿀 수 없습니다'),
        );
        expect(tx.roleGroupMenu.upsert).not.toHaveBeenCalled();
      });

      it('묶음 칸은 하위에서 정해지므로 상한을 보지 않는다', async () => {
        grants[2] = rows(
          [11, true, false, false, false],
          [12, true, true, true, false],
        );
        grants[5] = [];
        await save(PA, 5, [cells(11, true)]); // 10(묶음) 조회가 따라 켜진다 — 호출자에게 10 행이 없어도 된다
        const ids = tx.roleGroupMenu.upsert.mock.calls.map(
          ([a]) => a.where.roleGroupId_menuId.menuId,
        );
        expect(ids).toEqual([10, 11]);
      });

      it('PA 고정 권한(is_master, 시드되면)에도 건다', async () => {
        const other: MenuCaller = {
          adminAccountId: 8,
          roleTypeCode: 'PA',
          roleGroupId: 5,
        };
        permissions.caller.mockResolvedValue(other);
        await expect(save(other, 2, [cells(22, true)])).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('PM 호출자에게는 없다', async () => {
        await save(PM, 5, [cells(22, true, true, true, true)]);
        expect(tx.roleGroupMenu.upsert).toHaveBeenCalled();
      });

      it('BP 마스터에는 걸지 않는다', async () => {
        await save(PA, 3, [cells(22, true, true, true, false)]);
        expect(tx.roleGroupMenu.upsert).toHaveBeenCalled();
      });
    });

    describe('회수 연쇄', () => {
      it('BP 마스터에서 끈 칸은 모든 BP 의 지우지 않은 BA 그룹의 같은 칸도 끈다', async () => {
        childRows = [
          { roleGroupId: 40, ...rows([22, true, true, true, true])[0] },
          { roleGroupId: 41, ...rows([22, true, false, false, false])[0] },
        ];
        await save(PM, 3, [cells(22, true, true, true, false)]); // 삭제 회수
        const query = tx.roleGroupMenu.findMany.mock.calls.find(
          ([a]) => a.where.menuId,
        )[0];
        expect(query.where).toEqual({
          menuId: { in: [22] },
          isDeleted: false,
          roleGroup: { isDeleted: false, roleTypeCode: 'BA' },
        });
        expect(tx.roleGroupMenu.update).toHaveBeenCalledTimes(1);
        expect(tx.roleGroupMenu.update).toHaveBeenCalledWith({
          where: { roleGroupId_menuId: { roleGroupId: 40, menuId: 22 } },
          data: {
            isReadable: true,
            isCreatable: true,
            isUpdatable: true,
            isDeletable: false,
            updatedBy: PM.adminAccountId,
          },
        });
        expect(tx.roleGroup.updateMany).toHaveBeenLastCalledWith({
          where: { roleGroupId: { in: [40] } },
          data: { updatedBy: PM.adminAccountId },
        });
      });

      it('조회를 회수하면 BA 그룹의 그 줄 전체가 꺼진다', async () => {
        childRows = [
          { roleGroupId: 40, ...rows([22, true, true, false, false])[0] },
        ];
        await save(PM, 3, [cells(22, false)]);
        expect(tx.roleGroupMenu.update.mock.calls[0][0].data).toMatchObject({
          isReadable: false,
          isCreatable: false,
        });
      });

      it('BA 그룹에서 하위 조회가 모두 꺼지면 그 그룹의 묶음 메뉴 조회도 끈다', async () => {
        // BP 마스터에는 21 조회가 남아 묶음 20 이 켜져 있지만, BA 40 은 22 만 갖고 있었다.
        grants[40] = rows(
          [20, true, false, false, false],
          [22, true, false, false, false],
        );
        childRows = [
          { roleGroupId: 40, ...rows([22, true, false, false, false])[0] },
        ];
        await save(PM, 3, [cells(22, false)]);
        const updated = tx.roleGroupMenu.update.mock.calls.map(([a]) => [
          a.where.roleGroupId_menuId.menuId,
          a.data.isReadable,
        ]);
        expect(updated).toEqual([
          [22, false],
          [20, false],
        ]);
      });

      it('BA 그룹에 다른 하위 조회가 남으면 묶음 메뉴는 그대로', async () => {
        grants[40] = rows(
          [20, true, false, false, false],
          [21, true, false, false, false],
          [22, true, false, false, false],
        );
        childRows = [
          { roleGroupId: 40, ...rows([22, true, false, false, false])[0] },
        ];
        await save(PM, 3, [cells(22, false)]);
        expect(tx.roleGroupMenu.update).toHaveBeenCalledTimes(1);
      });

      it('가맹 마스터는 FA 그룹으로 이어진다', async () => {
        TARGETS[4] = {
          roleGroupId: 4,
          roleCode: 'FM000001',
          roleTypeCode: 'FM',
          name: '가맹 마스터',
          isMaster: true,
        };
        grants[4] = rows([22, true, true, false, false]);
        await save(PM, 4, [cells(22, true)]);
        const query = tx.roleGroupMenu.findMany.mock.calls.find(
          ([a]) => a.where.menuId,
        )[0];
        expect(query.where.roleGroup.roleTypeCode).toBe('FA');
      });

      it('켜기만 했으면 하위 그룹을 찾지 않는다. 플랫폼 관리자 권한은 회수해도 연쇄가 없다', async () => {
        await save(PM, 3, [cells(21, true, true, true, true)]);
        await save(PM, 5, [cells(11, false)]);
        expect(
          tx.roleGroupMenu.findMany.mock.calls.some(([a]) => a.where.menuId),
        ).toBe(false);
      });
    });
  });

  describe('preview', () => {
    it('BP 마스터에서 꺼지는 칸 · 영향 받는 BA 그룹 · 연결 관리자(고정 권한 자신 포함)를 센다 — 쓰지 않는다', async () => {
      childRows = [
        { roleGroupId: 40, ...rows([22, true, true, true, true])[0] },
        { roleGroupId: 41, ...rows([22, true, false, false, false])[0] },
        { roleGroupId: 42, ...rows([21, true, false, false, false])[0] },
      ];
      prisma.adminAccount.count.mockResolvedValue(7);
      const result = await service.preview(PM.adminAccountId, 3, {
        menus: [cells(22, true, false, false, false)], // 등록 · 수정 · 삭제 회수 = 3칸
      });
      expect(result).toEqual({
        revokedCells: 3,
        affectedRoleGroupCount: 1,
        affectedAdminCount: 7,
      });
      expect(prisma.adminAccount.count).toHaveBeenCalledWith({
        where: { isDeleted: false, roleGroupId: { in: [40, 3] } },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('조회를 끄면 그 줄의 네 칸과 묶음의 조회까지 센다', async () => {
      const result = await service.preview(PM.adminAccountId, 3, {
        menus: [cells(21, false), cells(22, false)],
      });
      // 21 RCUD 4 + 22 RCUD 4 + 묶음 20 R 1
      expect(result.revokedCells).toBe(9);
    });

    it('BP 마스터라도 꺼지는 칸이 없으면 셋 다 0 — 연결 관리자를 세지 않는다', async () => {
      prisma.adminAccount.count.mockResolvedValue(7);
      const result = await service.preview(PM.adminAccountId, 3, {
        menus: [cells(22, true, true, true, true)], // 지금 값 그대로
      });
      expect(result).toEqual({
        revokedCells: 0,
        affectedRoleGroupCount: 0,
        affectedAdminCount: 0,
      });
      expect(prisma.adminAccount.count).not.toHaveBeenCalled();
    });

    it('플랫폼 관리자 권한은 연쇄가 없어 0 · 0', async () => {
      const result = await service.preview(PM.adminAccountId, 5, {
        menus: [cells(11, false)],
      });
      expect(result).toEqual({
        revokedCells: 2,
        affectedRoleGroupCount: 0,
        affectedAdminCount: 0,
      });
      expect(prisma.adminAccount.count).not.toHaveBeenCalled();
    });

    it('숨긴 메뉴를 보내면 400', async () => {
      await expect(
        service.preview(PM.adminAccountId, 3, { menus: [cells(13, true)] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('플랫폼 마스터 권한은 저장처럼 409', async () => {
      await expect(
        service.preview(PA.adminAccountId, 1, { menus: [cells(11, false)] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('저장이 400 일 변경은 미리보기도 400 — BP 마스터에 플랫폼 메뉴 켜기', async () => {
      await expect(
        service.preview(PM.adminAccountId, 3, { menus: [cells(11, true)] }),
      ).rejects.toThrow(
        new BadRequestException(
          'BP 마스터·가맹 마스터 권한에는 플랫폼 관리 메뉴를 줄 수 없습니다',
        ),
      );
    });

    it('저장이 400 일 변경은 미리보기도 400 — PA 호출자의 범위 밖 칸', async () => {
      await expect(
        service.preview(PA.adminAccountId, 5, {
          menus: [cells(11, true, false, false, true)],
        }),
      ).rejects.toThrow(
        new BadRequestException('본인 권한 범위 밖 칸은 바꿀 수 없습니다'),
      );
    });
  });
});
