// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import {
  type MenuCaller,
  MenuPermissionsService,
} from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformRoleGroupsService } from './platform-role-groups.service';

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
const PLATFORM_BP_ID = 1;

function group(overrides: Record<string, unknown> = {}) {
  return {
    roleGroupId: 5,
    roleCode: 'PA000002',
    roleTypeCode: 'PA',
    name: '고객지원 담당',
    description: '커뮤니티관리·BP 조회',
    isMaster: false,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date(UPDATED_AT),
    creator: { name: '정민재', loginId: 'platjung' },
    updater: null,
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

describe('PlatformRoleGroupsService', () => {
  let service: PlatformRoleGroupsService;
  let prisma: Record<string, any>;
  /** 호출자는 id 로 읽는다 — PM(1) · PA(2). */
  let permissions: { caller: jest.Mock };
  /** 트랜잭션 안에서만 쓰는 클라이언트. 밖의 prisma 와 갈라 「쓰기는 트랜잭션 안에서」를 확인한다. */
  let tx: Record<string, any>;

  beforeEach(async () => {
    permissions = {
      caller: jest.fn((id: number) =>
        Promise.resolve([PM, PA].find((c) => c.adminAccountId === id)),
      ),
    };
    prisma = {
      roleGroup: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(group()),
      },
      roleGroupMenu: {
        findFirst: jest.fn().mockResolvedValue({
          isReadable: true,
          isCreatable: true,
          isUpdatable: true,
          isDeletable: true,
        }),
      },
      bpCode: {
        findFirst: jest.fn().mockResolvedValue({ bpCodeId: PLATFORM_BP_ID }),
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
      roleGroupMenu: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminAccount: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction = jest.fn((fn: (t: unknown) => unknown) => fn(tx));
    const module = await Test.createTestingModule({
      providers: [
        PlatformRoleGroupsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MenuPermissionsService, useValue: permissions },
      ],
    }).compile();
    service = module.get(PlatformRoleGroupsService);
  });

  describe('호출자', () => {
    const body = { name: 'a', updatedAt: UPDATED_AT };
    it.each([
      ['detail', () => service.detail(PA.adminAccountId, 5)],
      ['create', () => service.create(PA.adminAccountId, { name: 'a' })],
      ['update', () => service.update(PA.adminAccountId, 5, body)],
      [
        'remove',
        () => service.remove(PA.adminAccountId, 5, { updatedAt: UPDATED_AT }),
      ],
    ] as const)('%s 는 받은 관리자 id 로 호출자를 읽는다', async (_, call) => {
      // 결과가 아니라 호출자를 무엇으로 읽는지만 본다.
      await call().catch(() => undefined);
      expect(permissions.caller).toHaveBeenCalledWith(PA.adminAccountId);
    });

    it('계정을 쓸 수 없으면 caller 의 403 을 그대로 내고 쓰지 않는다', async () => {
      permissions.caller.mockRejectedValue(new ForbiddenException('x'));
      await expect(
        service.update(PA.adminAccountId, 5, body),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('목록 · 삭제 후보는 호출자를 읽지 않는다', async () => {
      await service.list();
      await service.deletionCandidates(5);
      expect(permissions.caller).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('플랫폼 BP 의 지우지 않은 PM · PA · BM · FM 만 읽고, 고정 넷 다음 추가 권한을 코드 순으로 준다', async () => {
      prisma.roleGroup.findMany.mockResolvedValue([
        group({
          roleGroupId: 6,
          roleCode: 'PA000003',
          _count: { menus: 0, adminAccounts: 0 },
        }),
        group({
          roleGroupId: 4,
          roleCode: 'FM000001',
          roleTypeCode: 'FM',
          isMaster: true,
        }),
        group({ roleGroupId: 5 }),
        group({
          roleGroupId: 1,
          roleCode: 'PM000001',
          roleTypeCode: 'PM',
          isMaster: true,
        }),
      ]);
      const result = await service.list();
      const { where } = prisma.roleGroup.findMany.mock.calls[0][0];
      expect(where).toEqual({
        isDeleted: false,
        roleTypeCode: { in: ['PM', 'PA', 'BM', 'FM'] },
        bpCode: { isPlatform: true },
      });
      expect(result.total).toBe(4);
      expect(result.items.map((i) => i.roleCode)).toEqual([
        'PM000001',
        'FM000001',
        'PA000002',
        'PA000003',
      ]);
      expect(result.items[2]).toEqual({
        roleGroupId: 5,
        roleCode: 'PA000002',
        roleTypeCode: 'PA',
        name: '고객지원 담당',
        description: '커뮤니티관리·BP 조회',
        isMaster: false,
        isMenuRegistered: true,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        createdBy: { name: '정민재', loginId: 'platjung' },
        updatedAt: new Date(UPDATED_AT),
        updatedBy: null,
        adminCount: 2,
      });
      expect(result.items[3].isMenuRegistered).toBe(false);
    });

    it('메뉴 등록 여부는 조회가 켜진 지우지 않은 행을, 관리자 수는 지우지 않은 관리자를 센다', async () => {
      await service.list();
      const { select } = prisma.roleGroup.findMany.mock.calls[0][0];
      expect(select._count.select).toEqual({
        menus: {
          where: {
            isDeleted: false,
            isReadable: true,
            menu: { isDeleted: false },
          },
        },
        adminAccounts: { where: { isDeleted: false } },
      });
    });
  });

  describe('detail', () => {
    it('없거나 지운 · 플랫폼 권한이 아닌 그룹은 404', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      await expect(service.detail(PM.adminAccountId, 5)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.roleGroup.findFirst.mock.calls[0][0].where).toEqual({
        roleGroupId: 5,
        isDeleted: false,
        roleTypeCode: { in: ['PM', 'PA', 'BM', 'FM'] },
        bpCode: { isPlatform: true },
      });
    });

    it('수정 · 삭제 권한이 있고 본인 연결이 아니면 고치고 지울 수 있다', async () => {
      const result = await service.detail(PM.adminAccountId, 5);
      expect(result).toMatchObject({
        isEditable: true,
        editBlockedReason: null,
        isDeletable: true,
        deleteBlockedReason: null,
      });
      // 호출자 권한 그룹의 MN000214 행을 본다.
      expect(prisma.roleGroupMenu.findFirst.mock.calls[0][0].where).toEqual({
        roleGroupId: PM.roleGroupId,
        isDeleted: false,
        menu: { menuCode: 'MN000214', isDeleted: false },
      });
    });

    it('PA 가 아닌 비고정 행(데이터 오류)도 삭제는 FIXED_ROLE — 삭제 API 와 같은 판정', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(
        group({ roleTypeCode: 'BM', isMaster: false }),
      );
      expect(await service.detail(PM.adminAccountId, 5)).toMatchObject({
        isDeletable: false,
        deleteBlockedReason: 'FIXED_ROLE',
      });
    });

    it('본인이 연결된 권한은 수정 · 삭제 모두 SELF_LINKED', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(group({ roleGroupId: 2 }));
      expect(await service.detail(PA.adminAccountId, 2)).toMatchObject({
        isEditable: false,
        editBlockedReason: 'SELF_LINKED',
        isDeletable: false,
        deleteBlockedReason: 'SELF_LINKED',
      });
    });

    it('고정 권한은 지울 수 없다 — 무엇보다 먼저 FIXED_ROLE. 이름 · 설명은 고칠 수 있다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(
        group({
          roleGroupId: 1,
          roleCode: 'PM000001',
          roleTypeCode: 'PM',
          isMaster: true,
        }),
      );
      expect(await service.detail(PA.adminAccountId, 1)).toMatchObject({
        isEditable: true,
        isDeletable: false,
        deleteBlockedReason: 'FIXED_ROLE',
      });
    });

    it('수정 · 삭제 메뉴 권한이 없으면 NO_PERMISSION', async () => {
      prisma.roleGroupMenu.findFirst.mockResolvedValue({
        isReadable: true,
        isCreatable: false,
        isUpdatable: false,
        isDeletable: false,
      });
      expect(await service.detail(PA.adminAccountId, 5)).toMatchObject({
        editBlockedReason: 'NO_PERMISSION',
        deleteBlockedReason: 'NO_PERMISSION',
      });
    });
  });

  describe('create', () => {
    it('PA 추가 권한을 잠금 안에서 채번해 만든다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null); // 이름 중복 없음
      tx.roleGroup.findFirst.mockResolvedValue({ roleCode: 'PA000004' });
      const result = await service.create(PA.adminAccountId, {
        name: '정산 담당',
        description: null,
      });
      expect(result).toEqual({ roleGroupId: 9, roleCode: 'PA000005' });
      expect(tx.$executeRaw).toHaveBeenCalled();
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.roleGroup.findFirst.mock.invocationCallOrder[0],
      );
      // 지운 그룹까지 포함한 마지막 PA 코드 — isDeleted 조건이 없다.
      expect(tx.roleGroup.findFirst.mock.calls[0][0]).toEqual({
        where: { roleCode: { startsWith: 'PA' } },
        orderBy: { roleCode: 'desc' },
        select: { roleCode: true },
      });
      expect(tx.roleGroup.create.mock.calls[0][0].data).toEqual({
        roleCode: 'PA000005',
        bpCodeId: PLATFORM_BP_ID,
        roleTypeCode: 'PA',
        name: '정산 담당',
        description: null,
        isMaster: false,
        createdBy: PA.adminAccountId,
        updatedBy: PA.adminAccountId,
      });
    });

    it('PA 권한이 하나도 없으면 PA000001 부터 — 고정 권한이 아니라 추가 권한이다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      tx.roleGroup.findFirst.mockResolvedValue(null);
      expect(
        (await service.create(PM.adminAccountId, { name: 'a' })).roleCode,
      ).toBe('PA000001');
      expect(tx.roleGroup.create.mock.calls[0][0].data.isMaster).toBe(false);
    });

    it('999999 를 넘으면 409', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      tx.roleGroup.findFirst.mockResolvedValue({ roleCode: 'PA999999' });
      await expect(
        service.create(PM.adminAccountId, { name: 'a' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.roleGroup.create).not.toHaveBeenCalled();
    });

    it('플랫폼 권한 안에 같은 이름이 있으면 409 — 만들지 않는다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue({ roleGroupId: 3 });
      await expect(
        service.create(PM.adminAccountId, { name: 'BP 마스터' }),
      ).rejects.toThrow(new ConflictException('같은 이름의 권한이 있습니다'));
      expect(prisma.roleGroup.findFirst.mock.calls[0][0].where).toEqual({
        bpCodeId: PLATFORM_BP_ID,
        managerAdminAccountId: null,
        name: 'BP 마스터',
        isDeleted: false,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('확인과 INSERT 사이에 같은 이름이 먼저 들어가 고유 인덱스에 걸리면 409', async () => {
      prisma.roleGroup.findFirst
        .mockResolvedValueOnce(null) // 쓰기 전 확인
        .mockResolvedValueOnce({ roleGroupId: 3 }); // 위반 뒤 다시 보니 이름이 있다
      tx.roleGroup.create.mockRejectedValue(uniqueViolation());
      await expect(
        service.create(PM.adminAccountId, { name: 'a' }),
      ).rejects.toThrow(new ConflictException('같은 이름의 권한이 있습니다'));
    });

    it('이름이 아닌 고유 위반(권한 코드 등)은 409 로 바꾸지 않고 그대로 던진다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null); // 위반 뒤에도 이름은 비어 있다
      const violation = uniqueViolation();
      tx.roleGroup.create.mockRejectedValue(violation);
      await expect(
        service.create(PM.adminAccountId, { name: 'a' }),
      ).rejects.toBe(violation);
    });

    it('플랫폼 BP 가 없으면 원인을 적은 500', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(
        service.create(PM.adminAccountId, { name: 'a' }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('update', () => {
    const body = {
      name: '고객지원',
      description: '커뮤니티관리·BP 조회',
      updatedAt: UPDATED_AT,
    };

    it('같은 ms 의 updatedAt 일 때만 고친다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null); // 이름 중복 없음
      await service.update(PM.adminAccountId, 5, body);
      expect(tx.roleGroup.updateMany).toHaveBeenCalledWith({
        where: {
          roleGroupId: 5,
          isDeleted: false,
          updatedAt: {
            gte: new Date(UPDATED_AT),
            lt: new Date(new Date(UPDATED_AT).getTime() + 1),
          },
        },
        data: {
          name: '고객지원',
          description: '커뮤니티관리·BP 조회',
          updatedBy: PM.adminAccountId,
        },
      });
    });

    it('그 사이 다른 사람이 고쳤으면 409', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      tx.roleGroup.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.update(PM.adminAccountId, 5, body),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('그 사이 그룹이 지워졌으면 409 가 아니라 404', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      tx.roleGroup.findFirst
        .mockResolvedValueOnce(group())
        .mockResolvedValueOnce(null);
      tx.roleGroup.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.update(PM.adminAccountId, 5, body),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('본인이 연결된 권한은 403', async () => {
      await expect(service.update(PA.adminAccountId, 2, body)).rejects.toThrow(
        new ForbiddenException('본인이 연결된 권한이라 고칠 수 없습니다'),
      );
      expect(tx.roleGroup.updateMany).not.toHaveBeenCalled();
    });

    it('PA 는 PM000001 의 권한명 · 설명을 고칠 수 있다', async () => {
      tx.roleGroup.findFirst.mockResolvedValue(
        group({
          roleGroupId: 1,
          roleCode: 'PM000001',
          roleTypeCode: 'PM',
          isMaster: true,
        }),
      );
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      await service.update(PA.adminAccountId, 1, body);
      expect(tx.roleGroup.updateMany).toHaveBeenCalled();
    });

    it('없는 그룹은 404', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      tx.roleGroup.findFirst.mockResolvedValue(null);
      await expect(
        service.update(PM.adminAccountId, 5, body),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('다른 권한과 같은 이름이면 409 — 자기 자신은 빼고 본다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue({ roleGroupId: 3 });
      await expect(service.update(PM.adminAccountId, 5, body)).rejects.toThrow(
        new ConflictException('같은 이름의 권한이 있습니다'),
      );
      expect(prisma.roleGroup.findFirst.mock.calls[0][0].where).toMatchObject({
        roleGroupId: { not: 5 },
      });
    });
  });

  describe('deletionCandidates', () => {
    it('연결 관리자(미사용 포함)와 고정 권한(is_master)을 뺀 다른 추가 권한을 준다', async () => {
      prisma.adminAccount.findMany.mockResolvedValue([
        {
          adminAccountId: 7,
          loginId: 'platpark',
          name: '박지우',
          accountStatusCode: 'ACTIVE',
        },
      ]);
      prisma.roleGroup.findMany.mockResolvedValue([
        { roleGroupId: 6, roleCode: 'PA000003', name: '정산 담당' },
      ]);
      const result = await service.deletionCandidates(5);
      expect(result.admins).toHaveLength(1);
      expect(result.candidates).toEqual([
        { roleGroupId: 6, roleCode: 'PA000003', name: '정산 담당' },
      ]);
      expect(prisma.adminAccount.findMany.mock.calls[0][0].where).toEqual({
        roleGroupId: 5,
        isDeleted: false,
      });
      expect(prisma.roleGroup.findMany.mock.calls[0][0].where).toEqual({
        roleGroupId: { not: 5 },
        isDeleted: false,
        isMaster: false,
        roleTypeCode: 'PA',
        bpCode: { isPlatform: true },
      });
    });

    it('없는 그룹은 404', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);
      await expect(service.deletionCandidates(5)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      ['고정 권한', group({ isMaster: true })],
      ['PA 가 아닌 그룹', group({ roleTypeCode: 'BM' })],
    ])('지울 수 없는 권한(%s)은 409 — 후보를 주지 않는다', async (_, row) => {
      prisma.roleGroup.findFirst.mockResolvedValue(row);
      await expect(service.deletionCandidates(5)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.adminAccount.findMany).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    const replacement = {
      roleGroupId: 6,
      roleCode: 'PA000003',
      name: '정산 담당',
      roleTypeCode: 'PA',
      isMaster: false,
    };

    function targetThenReplacement(
      target = group(),
      repl: unknown = replacement,
    ) {
      tx.roleGroup.findFirst.mockImplementation(({ where }) =>
        Promise.resolve(where.roleGroupId === 5 ? target : repl),
      );
    }

    it('대상 · 대체 행을 잠근 뒤 연결 관리자를 옮기고(관리자 변경 이력) 메뉴 · 그룹을 지운다', async () => {
      targetThenReplacement();
      tx.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: 7 },
        { adminAccountId: 8 },
      ]);
      await service.remove(PM.adminAccountId, 5, {
        replacementRoleGroupId: 6,
        updatedAt: UPDATED_AT,
      });
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.roleGroup.findFirst.mock.invocationCallOrder[0],
      );
      // 이력을 남긴 관리자만 옮긴다 — 그 사이 붙은 관리자가 이력 없이 옮겨지지 않게.
      expect(tx.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: { in: [7, 8] }, isDeleted: false },
        data: { roleGroupId: 6, updatedBy: PM.adminAccountId },
      });
      expect(tx.adminChangeHistory.createMany).toHaveBeenCalledWith({
        data: [7, 8].map((adminAccountId) => ({
          adminAccountId,
          field: '사용자 권한',
          beforeValue: '고객지원 담당 PA000002',
          afterValue: '정산 담당 PA000003',
          changedBy: PM.adminAccountId,
        })),
      });
      expect(tx.roleGroupMenu.updateMany).toHaveBeenCalledWith({
        where: { roleGroupId: 5, isDeleted: false },
        data: { isDeleted: true, updatedBy: PM.adminAccountId },
      });
      expect(tx.roleGroup.update).toHaveBeenCalledWith({
        where: { roleGroupId: 5 },
        data: { isDeleted: true, updatedBy: PM.adminAccountId },
      });
      expect(prisma.adminAccount.findMany).not.toHaveBeenCalled();
    });

    it('연결 사용자가 없으면 대체 없이 지운다', async () => {
      targetThenReplacement();
      await service.remove(PM.adminAccountId, 5, { updatedAt: UPDATED_AT });
      expect(tx.adminAccount.updateMany).not.toHaveBeenCalled();
      expect(tx.adminChangeHistory.createMany).not.toHaveBeenCalled();
      expect(tx.roleGroup.update).toHaveBeenCalled();
    });

    it('연결 사용자가 있는데 대체가 없으면 400 — 아무것도 바꾸지 않는다', async () => {
      targetThenReplacement();
      tx.adminAccount.findMany.mockResolvedValue([{ adminAccountId: 7 }]);
      await expect(
        service.remove(PM.adminAccountId, 5, { updatedAt: UPDATED_AT }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.roleGroup.update).not.toHaveBeenCalled();
    });

    it('잠그는 id 는 작은 것부터다 — 두 삭제가 서로를 기다리며 멈추지 않게', async () => {
      targetThenReplacement(group(), { ...replacement, roleGroupId: 4 });
      await service.remove(PM.adminAccountId, 5, {
        replacementRoleGroupId: 4,
        updatedAt: UPDATED_AT,
      });
      expect(tx.$queryRaw.mock.calls[0][1].values).toEqual([4, 5]);
    });

    it('고정 권한은 409', async () => {
      targetThenReplacement(group({ roleCode: 'PA900000', isMaster: true }));
      await expect(
        service.remove(PM.adminAccountId, 5, { updatedAt: UPDATED_AT }),
      ).rejects.toThrow(
        new ConflictException('고정 권한은 삭제할 수 없습니다'),
      );
    });

    it('고정이 아니어도 PA 가 아닌 그룹은 409 — 관리자를 다른 유형 권한으로 옮기지 않게', async () => {
      targetThenReplacement(group({ roleTypeCode: 'BM' }));
      await expect(
        service.remove(PM.adminAccountId, 5, { updatedAt: UPDATED_AT }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.roleGroup.update).not.toHaveBeenCalled();
    });

    it('연결 사용자가 없어도 고를 수 없는 대체 권한을 보내면 400', async () => {
      targetThenReplacement(group(), null);
      await expect(
        service.remove(PM.adminAccountId, 5, {
          replacementRoleGroupId: 6,
          updatedAt: UPDATED_AT,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.roleGroup.update).not.toHaveBeenCalled();
    });

    it('본인이 연결된 권한은 403', async () => {
      targetThenReplacement(group({ roleGroupId: 2 }));
      tx.roleGroup.findFirst.mockResolvedValue(group({ roleGroupId: 2 }));
      await expect(
        service.remove(PA.adminAccountId, 2, { updatedAt: UPDATED_AT }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('PA 고정 권한(is_master, 시드되면)을 대체로 고르면 400', async () => {
      targetThenReplacement(group(), {
        ...replacement,
        roleCode: 'PA900000',
        isMaster: true,
      });
      tx.adminAccount.findMany.mockResolvedValue([{ adminAccountId: 7 }]);
      await expect(
        service.remove(PM.adminAccountId, 5, {
          replacementRoleGroupId: 6,
          updatedAt: UPDATED_AT,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          '고정 권한 PA900000 은 대체 권한으로 고를 수 없습니다',
        ),
      );
    });

    it.each([
      ['없거나 지운 그룹', null],
      ['PA 가 아닌 그룹', { ...replacement, roleTypeCode: 'BM' }],
    ])('후보가 아닌 대체(%s)는 400', async (_, repl) => {
      targetThenReplacement(group(), repl);
      tx.adminAccount.findMany.mockResolvedValue([{ adminAccountId: 7 }]);
      await expect(
        service.remove(PM.adminAccountId, 5, {
          replacementRoleGroupId: 6,
          updatedAt: UPDATED_AT,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('자기 자신을 대체로 고르면 400', async () => {
      targetThenReplacement();
      await expect(
        service.remove(PM.adminAccountId, 5, {
          replacementRoleGroupId: 5,
          updatedAt: UPDATED_AT,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updatedAt 이 다르면 409', async () => {
      targetThenReplacement(
        group({ updatedAt: new Date('2026-10-15T02:00:00Z') }),
      );
      await expect(
        service.remove(PM.adminAccountId, 5, { updatedAt: UPDATED_AT }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.roleGroup.update).not.toHaveBeenCalled();
    });

    it('없는 그룹은 404', async () => {
      targetThenReplacement(null as never);
      await expect(
        service.remove(PM.adminAccountId, 5, { updatedAt: UPDATED_AT }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
