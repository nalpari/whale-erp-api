// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import type { BpScope } from './bp-role-group-access';
import { BpRoleGroupsService } from './bp-role-groups.service';

const UPDATED_AT = '2026-10-15T01:00:00.000Z';

const BM: BpScope = {
  caller: { adminAccountId: 10, roleTypeCode: 'BM', roleGroupId: 2 },
  bpCodeId: 7,
  managerId: null,
  writableType: 'BA',
};
const BA: BpScope = {
  caller: { adminAccountId: 11, roleTypeCode: 'BA', roleGroupId: 5 },
  bpCodeId: 7,
  managerId: null,
  writableType: null,
};
const FM: BpScope = {
  caller: { adminAccountId: 30, roleTypeCode: 'FM', roleGroupId: 3 },
  bpCodeId: 7,
  managerId: 30,
  writableType: 'FA',
};

function group(overrides: Record<string, unknown> = {}) {
  return {
    roleGroupId: 5,
    roleCode: 'BA000002',
    roleTypeCode: 'BA',
    name: '매장 운영',
    description: null,
    isMaster: false,
    managerAdminAccountId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date(UPDATED_AT),
    creator: { name: '김본사', loginId: 'bphq' },
    updater: null,
    manager: null,
    _count: { menus: 3, adminAccounts: 2 },
    ...overrides,
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('BpRoleGroupsService', () => {
  let service: BpRoleGroupsService;
  let prisma: Record<string, any>;
  let tx: Record<string, any>;
  let permissions: { caller: jest.Mock };

  beforeEach(async () => {
    permissions = { caller: jest.fn().mockResolvedValue(BM.caller) };
    prisma = {
      roleGroup: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(group()),
        count: jest.fn().mockResolvedValue(0),
      },
      adminAccount: { findMany: jest.fn().mockResolvedValue([]) },
    };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      roleGroup: {
        findFirst: jest.fn().mockResolvedValue(group()),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ roleGroupId: 9, roleCode: data.roleCode }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      roleGroupMenu: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      adminAccount: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction = jest.fn((arg: unknown) =>
      typeof arg === 'function' ? arg(tx) : Promise.all(arg as unknown[]),
    );
    const module = await Test.createTestingModule({
      providers: [
        BpRoleGroupsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MenuPermissionsService, useValue: permissions },
      ],
    }).compile();
    service = module.get(BpRoleGroupsService);
  });

  describe('scopeOf', () => {
    it('호출자 계정을 다시 읽어 범위를 정한다', async () => {
      prisma.adminAccount.findUniqueOrThrow = jest.fn().mockResolvedValue({
        bpCodeId: 7,
        bpCode: { isPlatform: false },
        roleGroup: { managerAdminAccountId: null },
      });
      expect(
        await service.scopeOf(10, { bpCodeId: 7, isPlatformCaller: false }),
      ).toEqual(BM);
      expect(permissions.caller).toHaveBeenCalledWith(10);
    });
  });

  describe('list', () => {
    it('범위 안의 그룹을 코드 · id 순으로 쪽 나눠 읽고, 같은 조건으로 센다', async () => {
      // 목록은 관리계정 id 를 읽지 않는다(manager 로 준다).
      const row = (o: Record<string, unknown> = {}) => {
        const rest: Record<string, unknown> = group(o);
        delete rest.managerAdminAccountId;
        return rest;
      };
      prisma.roleGroup.findMany.mockResolvedValue([
        row(),
        row({
          roleGroupId: 8,
          roleCode: 'FA000001',
          roleTypeCode: 'FA',
          manager: { adminAccountId: 30, loginId: 'fm01', name: '이가맹' },
          _count: { menus: 0, adminAccounts: 0 },
        }),
      ]);
      prisma.roleGroup.count.mockResolvedValue(42);
      const result = await service.list(BA, { page: 3, pageSize: 20 });

      const args = prisma.roleGroup.findMany.mock.calls[0][0];
      const where = {
        bpCodeId: 7,
        isDeleted: false,
        isMaster: false,
        roleTypeCode: { in: ['BA', 'FA'] },
      };
      expect(args.where).toEqual(where);
      expect(args.orderBy).toEqual([
        { roleCode: 'asc' },
        { roleGroupId: 'asc' },
      ]);
      expect(args).toMatchObject({ skip: 40, take: 20 });
      expect(prisma.roleGroup.count.mock.calls[0][0]).toEqual({ where });
      expect(result.total).toBe(42);
      expect(result.creatableRoleTypeCode).toBeNull();
      expect(result.items[0]).toEqual({
        roleGroupId: 5,
        roleCode: 'BA000002',
        roleTypeCode: 'BA',
        name: '매장 운영',
        description: null,
        isMaster: false,
        isMenuRegistered: true,
        menuCount: 3,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        createdBy: { name: '김본사', loginId: 'bphq' },
        updatedAt: new Date(UPDATED_AT),
        updatedBy: null,
        adminCount: 2,
        manager: null,
        isSelfLinked: true,
      });
      expect(result.items[1]).toMatchObject({
        manager: { adminAccountId: 30, loginId: 'fm01', name: '이가맹' },
        isSelfLinked: false,
        isMenuRegistered: false,
        menuCount: 0,
      });
    });

    it('등록 유형은 역할로 정한다', async () => {
      expect(
        (await service.list(BM, { page: 1, pageSize: 20 }))
          .creatableRoleTypeCode,
      ).toBe('BA');
      expect(
        (await service.list(FM, { page: 1, pageSize: 20 }))
          .creatableRoleTypeCode,
      ).toBe('FA');
    });
  });

  describe('detail', () => {
    it('범위 밖이면 404', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      await expect(service.detail(FM, 5)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.roleGroup.findFirst.mock.calls[0][0].where).toEqual({
        roleGroupId: 5,
        bpCodeId: 7,
        isDeleted: false,
        isMaster: false,
        roleTypeCode: 'FA',
        managerAdminAccountId: 30,
      });
    });

    it('BM 은 BA 를 고치고 지울 수 있다', async () => {
      expect(await service.detail(BM, 5)).toMatchObject({
        isEditable: true,
        editBlockedReason: null,
        isDeletable: true,
        deleteBlockedReason: null,
      });
    });

    it('역할로 못 고치면 NO_PERMISSION — BM 이 FA 를, BA 가 아무거나', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(
        group({ roleTypeCode: 'FA' }),
      );
      expect(await service.detail(BM, 5)).toMatchObject({
        isEditable: false,
        editBlockedReason: 'NO_PERMISSION',
        isDeletable: false,
        deleteBlockedReason: 'NO_PERMISSION',
      });
      prisma.roleGroup.findFirst.mockResolvedValue(group());
      expect(await service.detail(BA, 6)).toMatchObject({
        editBlockedReason: 'NO_PERMISSION',
      });
    });

    it('본인 연결 그룹은 SELF_LINKED', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(
        group({
          roleGroupId: 3,
          roleTypeCode: 'FA',
          managerAdminAccountId: 30,
        }),
      );
      expect(await service.detail(FM, 3)).toMatchObject({
        isEditable: false,
        editBlockedReason: 'SELF_LINKED',
        deleteBlockedReason: 'SELF_LINKED',
        isSelfLinked: true,
      });
    });
  });

  describe('create', () => {
    beforeEach(() => prisma.roleGroup.findFirst.mockResolvedValue(null));

    it('쓸 수 있는 유형이 없으면 403', async () => {
      await expect(service.create(BA, { name: '새 권한' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('BM 은 BA 를 관리계정 없이 만든다 — 유형별 잠금 뒤 다음 코드', async () => {
      tx.roleGroup.findFirst.mockResolvedValue({ roleCode: 'BA000011' });
      const result = await service.create(BM, {
        name: '매장 운영',
        description: '설명',
      });
      expect(result).toEqual({ roleGroupId: 9, roleCode: 'BA000012' });
      expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual([
        'role_groups:role_code:BA',
      ]);
      expect(tx.roleGroup.findFirst.mock.calls[0][0]).toMatchObject({
        where: { roleCode: { startsWith: 'BA' } },
        orderBy: { roleCode: 'desc' },
      });
      expect(tx.roleGroup.create.mock.calls[0][0].data).toMatchObject({
        roleCode: 'BA000012',
        bpCodeId: 7,
        roleTypeCode: 'BA',
        managerAdminAccountId: null,
        isMaster: false,
        createdBy: 10,
      });
    });

    it('FM 은 FA 를 본인 관리계정으로 만들고, 이름은 같은 BP · 같은 관리계정 안에서 본다', async () => {
      tx.roleGroup.findFirst.mockResolvedValue(null);
      await service.create(FM, { name: '매장 운영' });
      expect(tx.roleGroup.create.mock.calls[0][0].data).toMatchObject({
        roleCode: 'FA000001',
        roleTypeCode: 'FA',
        managerAdminAccountId: 30,
      });
      expect(prisma.roleGroup.findFirst.mock.calls[0][0].where).toEqual({
        bpCodeId: 7,
        managerAdminAccountId: 30,
        name: '매장 운영',
        isDeleted: false,
      });
    });

    it('같은 이름이면 409, 동시 등록이 인덱스에 걸려도 409', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue({ roleGroupId: 1 });
      await expect(service.create(BM, { name: 'x' })).rejects.toThrow(
        ConflictException,
      );
      prisma.roleGroup.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ roleGroupId: 1 });
      tx.roleGroup.create.mockRejectedValue(uniqueViolation());
      await expect(service.create(BM, { name: 'x' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    const dto = { updatedAt: UPDATED_AT, name: '새 이름' };

    it('범위 밖 404 · 역할 403 · 본인 연결 403', async () => {
      prisma.roleGroup.findFirst.mockResolvedValueOnce(null);
      await expect(service.update(BM, 5, dto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.update(BA, 5, dto)).rejects.toThrow(
        ForbiddenException,
      );
      prisma.roleGroup.findFirst.mockResolvedValue(group({ roleGroupId: 2 }));
      await expect(service.update(BM, 2, dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(tx.roleGroup.updateMany).not.toHaveBeenCalled();
    });

    it('같은 ms 일 때만 고치고, 아니면 409', async () => {
      prisma.roleGroup.findFirst
        .mockResolvedValueOnce(group())
        .mockResolvedValueOnce(null);
      await service.update(BM, 5, dto);
      expect(tx.roleGroup.updateMany.mock.calls[0][0]).toMatchObject({
        where: { roleGroupId: 5, isDeleted: false },
        data: { name: '새 이름', description: null, updatedBy: 10 },
      });

      prisma.roleGroup.findFirst
        .mockResolvedValueOnce(group())
        .mockResolvedValueOnce(null);
      tx.roleGroup.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(BM, 5, dto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('deletionCandidates', () => {
    it('같은 BP · 같은 유형 · 같은 관리계정의 다른 비고정 그룹', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(
        group({ roleTypeCode: 'FA', managerAdminAccountId: 30 }),
      );
      await service.deletionCandidates(FM, 5);
      expect(prisma.roleGroup.findMany.mock.calls[0][0].where).toEqual({
        roleGroupId: { not: 5 },
        bpCodeId: 7,
        roleTypeCode: 'FA',
        managerAdminAccountId: 30,
        isDeleted: false,
        isMaster: false,
      });
      expect(prisma.adminAccount.findMany.mock.calls[0][0].where).toEqual({
        roleGroupId: 5,
        isDeleted: false,
      });
    });
  });

  describe('remove', () => {
    const dto = { updatedAt: UPDATED_AT };

    it('역할 403 · 본인 연결 403 · 다른 시각 409', async () => {
      await expect(service.remove(BA, 5, dto)).rejects.toThrow(
        ForbiddenException,
      );
      tx.roleGroup.findFirst.mockResolvedValueOnce(group({ roleGroupId: 2 }));
      await expect(service.remove(BM, 2, dto)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        service.remove(BM, 5, { updatedAt: '2026-10-15T01:00:00.001Z' }),
      ).rejects.toThrow(ConflictException);
      expect(tx.roleGroup.update).not.toHaveBeenCalled();
    });

    it('연결 사용자가 있는데 대체 그룹이 없으면 400, 후보가 아니면 400', async () => {
      tx.adminAccount.findMany.mockResolvedValue([{ adminAccountId: 50 }]);
      await expect(service.remove(BM, 5, dto)).rejects.toThrow(
        BadRequestException,
      );
      tx.roleGroup.findFirst
        .mockResolvedValueOnce(group())
        .mockResolvedValueOnce(null);
      await expect(
        service.remove(BM, 5, { ...dto, replacementRoleGroupId: 6 }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.roleGroup.findFirst.mock.calls[2][0].where).toEqual({
        roleGroupId: 6,
        bpCodeId: 7,
        roleTypeCode: 'BA',
        managerAdminAccountId: null,
        isDeleted: false,
        isMaster: false,
      });
    });

    it('대상 · 대체를 잠그고 관리자를 옮기며 이력을 남긴 뒤 메뉴 행과 그룹을 지운다', async () => {
      tx.roleGroup.findFirst
        .mockResolvedValueOnce(group())
        .mockResolvedValueOnce({
          roleGroupId: 6,
          roleCode: 'BA000003',
          name: '대체',
        });
      tx.adminAccount.findMany.mockResolvedValue([{ adminAccountId: 50 }]);
      await service.remove(BM, 5, { ...dto, replacementRoleGroupId: 6 });

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.adminAccount.updateMany.mock.calls[0][0]).toEqual({
        where: { adminAccountId: { in: [50] }, isDeleted: false },
        data: { roleGroupId: 6, updatedBy: 10 },
      });
      expect(tx.adminChangeHistory.createMany.mock.calls[0][0].data).toEqual([
        {
          adminAccountId: 50,
          field: '사용자 권한',
          beforeValue: '매장 운영 BA000002',
          afterValue: '대체 BA000003',
          changedBy: 10,
        },
      ]);
      expect(tx.roleGroupMenu.updateMany.mock.calls[0][0]).toEqual({
        where: { roleGroupId: 5, isDeleted: false },
        data: { isDeleted: true, updatedBy: 10 },
      });
      expect(tx.roleGroup.update.mock.calls[0][0]).toEqual({
        where: { roleGroupId: 5 },
        data: { isDeleted: true, updatedBy: 10 },
      });
    });
  });
});
