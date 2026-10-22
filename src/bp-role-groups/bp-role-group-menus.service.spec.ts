// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CodesService } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import type { BpScope } from './bp-role-group-access';
import { BpRoleGroupMenusService } from './bp-role-group-menus.service';

const UPDATED_AT = '2026-10-15T01:00:00.000Z';

const BM: BpScope = {
  caller: { adminAccountId: 10, roleTypeCode: 'BM', roleGroupId: 2 },
  bpCodeId: 7,
  managerId: null,
  writableType: 'BA',
};
const BA: BpScope = {
  caller: { adminAccountId: 11, roleTypeCode: 'BA', roleGroupId: 6 },
  bpCodeId: 7,
  managerId: null,
  writableType: null,
};
const FA: BpScope = {
  caller: { adminAccountId: 40, roleTypeCode: 'FA', roleGroupId: 8 },
  bpCodeId: 7,
  managerId: 30,
  writableType: null,
};

const menu = (o: Record<string, unknown>) => ({
  parentMenuId: null,
  serviceCode: 'WHALE_ERP',
  depth: 1,
  sortOrder: 1,
  status: 'ACTIVE',
  ...o,
});
const MENUS = [
  menu({ menuId: 1, menuCode: 'MN000001', name: '직원 관리' }),
  menu({
    menuId: 2,
    menuCode: 'MN000002',
    name: '직원 정보',
    parentMenuId: 1,
    depth: 2,
  }),
  menu({
    menuId: 3,
    menuCode: 'MN000214',
    name: '플랫폼 권한',
    serviceCode: 'PLATFORM',
  }),
];

const row = (menuId: number, r: boolean, c = false, u = false, d = false) => ({
  menuId,
  isReadable: r,
  isCreatable: c,
  isUpdatable: u,
  isDeletable: d,
});

/** roleGroupId 별 메뉴 행. 2 = BM000001(= BM 호출자 본인), 4 = FM000001, 5 = 대상 BA 그룹. */
const GRANTS: Record<number, ReturnType<typeof row>[]> = {
  2: [row(1, true), row(2, true, true, true, false)],
  4: [row(1, true), row(2, true)],
  5: [row(1, true), row(2, true)],
};
const MASTERS: Record<string, Record<string, unknown>> = {
  BM000001: { roleGroupId: 2 },
  FM000001: {
    roleGroupId: 4,
    roleCode: 'FM000001',
    roleTypeCode: 'FM',
    name: '가맹 마스터',
    updatedAt: new Date(UPDATED_AT),
  },
};
const TARGET = {
  roleGroupId: 5,
  roleCode: 'BA000002',
  roleTypeCode: 'BA',
  name: '매장 운영',
  managerAdminAccountId: null,
  updatedAt: new Date(UPDATED_AT),
};

describe('BpRoleGroupMenusService', () => {
  let service: BpRoleGroupMenusService;
  let prisma: Record<string, any>;
  let tx: Record<string, any>;
  let target: Record<string, unknown> | null;

  beforeEach(async () => {
    target = { ...TARGET };
    const roleGroup = {
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(where.roleCode ? MASTERS[where.roleCode] : target),
      ),
    };
    const roleGroupMenu = {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(GRANTS[where.roleGroupId] ?? []),
      ),
    };
    prisma = {
      roleGroup,
      roleGroupMenu,
      menu: { findMany: jest.fn().mockResolvedValue(MENUS) },
      adminAccount: { count: jest.fn().mockResolvedValue(3) },
    };
    tx = {
      roleGroup: {
        ...roleGroup,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ updatedAt: new Date('2026-10-15T02:00:00Z') }),
      },
      roleGroupMenu: { ...roleGroupMenu, upsert: jest.fn() },
    };
    prisma.$transaction = jest.fn((fn: (t: unknown) => unknown) => fn(tx));
    const codes = {
      forBp: jest.fn().mockResolvedValue({
        SERVICE: [
          { value: 'WHALE_ERP', label: 'Whale ERP' },
          { value: 'PLATFORM', label: '플랫폼 관리' },
        ],
      }),
    };
    const module = await Test.createTestingModule({
      providers: [
        BpRoleGroupMenusService,
        { provide: PrismaService, useValue: prisma },
        { provide: CodesService, useValue: codes },
      ],
    }).compile();
    service = module.get(BpRoleGroupMenusService);
  });

  const leaf = (tree: any) => tree.services[0].menus[0].children[0];

  describe('tree', () => {
    it('WHALE_ERP 메뉴만, 칸은 기준 고정 권한 ∩ 본인 권한 안에서만 열린다', async () => {
      const tree = await service.tree(BM, 5);
      expect(tree).toMatchObject({
        roleGroupId: 5,
        roleTypeCode: 'BA',
        isSavable: true,
      });
      expect(tree.services.map((s) => s.serviceCode)).toEqual(['WHALE_ERP']);
      expect(leaf(tree).read).toEqual({
        value: true,
        editable: true,
        blockedReason: null,
      });
      expect(leaf(tree).delete).toEqual({
        value: false,
        editable: false,
        blockedReason: 'OUT_OF_SCOPE',
      });
    });

    it('역할로 못 고치면 모든 칸 READ_ONLY · 저장 불가', async () => {
      const tree = await service.tree(BA, 5);
      expect(tree.isSavable).toBe(false);
      expect(leaf(tree).read.blockedReason).toBe('READ_ONLY');
    });

    it('본인 연결 그룹은 SELF_LINKED', async () => {
      target = { ...TARGET, roleGroupId: 2 };
      const tree = await service.tree(BM, 2);
      expect(tree.isSavable).toBe(false);
      expect(leaf(tree).read.blockedReason).toBe('SELF_LINKED');
    });

    it('범위 밖이면 404', async () => {
      target = null;
      await expect(service.tree(BM, 5)).rejects.toThrow(NotFoundException);
    });
  });

  describe('save', () => {
    const save = (menus: any[]) => ({ updatedAt: UPDATED_AT, menus });

    it('상한 안의 칸을 저장하고 새 updatedAt 을 준다', async () => {
      const result = await service.save(
        BM,
        5,
        save([
          { menuId: 2, read: true, create: true, update: false, delete: false },
        ]),
      );
      expect(result.updatedAt).toEqual(new Date('2026-10-15T02:00:00Z'));
      expect(tx.roleGroupMenu.upsert).toHaveBeenCalledTimes(1);
      expect(tx.roleGroupMenu.upsert.mock.calls[0][0].update).toMatchObject({
        isReadable: true,
        isCreatable: true,
        isDeleted: false,
        updatedBy: 10,
      });
    });

    it('상한 밖 칸은 400, 트리에 없는 메뉴(플랫폼 서비스)는 400', async () => {
      await expect(
        service.save(
          BM,
          5,
          save([
            {
              menuId: 2,
              read: true,
              create: false,
              update: false,
              delete: true,
            },
          ]),
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.save(
          BM,
          5,
          save([
            {
              menuId: 3,
              read: true,
              create: false,
              update: false,
              delete: false,
            },
          ]),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.roleGroupMenu.upsert).not.toHaveBeenCalled();
    });

    it('역할 403 · 본인 연결 403 · 동시 수정 409', async () => {
      await expect(service.save(BA, 5, save([]))).rejects.toThrow(
        ForbiddenException,
      );
      target = { ...TARGET, roleGroupId: 2 };
      await expect(service.save(BM, 2, save([]))).rejects.toThrow(
        ForbiddenException,
      );
      target = { ...TARGET };
      tx.roleGroup.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.save(BM, 5, save([]))).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('preview', () => {
    it('꺼지는 칸과 이 그룹의 관리자 수 — 하위 그룹은 없다', async () => {
      const result = await service.preview(BM, 5, {
        menus: [
          {
            menuId: 2,
            read: false,
            create: false,
            update: false,
            delete: false,
          },
        ],
      });
      // 직원 정보 조회 + 묶음(직원 관리) 조회가 꺼진다.
      expect(result).toEqual({
        revokedCells: 2,
        affectedRoleGroupCount: 0,
        affectedAdminCount: 3,
      });
      expect(prisma.adminAccount.count.mock.calls[0][0]).toEqual({
        where: { roleGroupId: 5, isDeleted: false },
      });
    });

    it('꺼지는 칸이 없으면 모두 0', async () => {
      const result = await service.preview(BM, 5, { menus: [] });
      expect(result).toEqual({
        revokedCells: 0,
        affectedRoleGroupCount: 0,
        affectedAdminCount: 0,
      });
    });
  });

  describe('franchiseMasterTree', () => {
    it('FM000001 트리를 모든 칸 읽기 전용으로', async () => {
      const tree = await service.franchiseMasterTree(BM);
      expect(tree).toMatchObject({
        roleGroupId: 4,
        roleCode: 'FM000001',
        roleTypeCode: 'FM',
        isSavable: false,
      });
      expect(leaf(tree).read).toEqual({
        value: true,
        editable: false,
        blockedReason: 'READ_ONLY',
      });
    });

    it('가맹 관리자는 403', async () => {
      await expect(service.franchiseMasterTree(FA)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
