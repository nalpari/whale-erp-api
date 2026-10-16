import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MenuPermissionsService } from './menu-permissions.service';

describe('MenuPermissionsService', () => {
  let service: MenuPermissionsService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { findFirst: jest.Mock };
  };

  // 사용 중이고 지우지 않은 PA, 권한 그룹 7
  const caller = { adminAccountId: 9, roleTypeCode: 'PA', roleGroupId: 7 };
  const grant = {
    isReadable: true,
    isCreatable: true,
    isUpdatable: true,
    isDeletable: false,
  };

  beforeEach(async () => {
    prisma = {
      adminAccount: { findFirst: jest.fn().mockResolvedValue(caller) },
      roleGroupMenu: { findFirst: jest.fn().mockResolvedValue(grant) },
    };
    const module = await Test.createTestingModule({
      providers: [
        MenuPermissionsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(MenuPermissionsService);
  });

  it('권한 그룹이 그 메뉴에 그 동작 권한을 가지면 호출한 관리자를 돌려준다', async () => {
    await expect(service.assert(9, 'MN000213', 'update')).resolves.toEqual(
      caller,
    );
  });

  it.each([
    ['read', 'isReadable'],
    ['create', 'isCreatable'],
    ['update', 'isUpdatable'],
    ['delete', 'isDeletable'],
  ] as const)('%s 는 %s 로 판정한다', async (action, flag) => {
    prisma.roleGroupMenu.findFirst.mockResolvedValue({
      isReadable: false,
      isCreatable: false,
      isUpdatable: false,
      isDeletable: false,
      [flag]: true,
    });
    await expect(service.assert(9, 'MN000213', action)).resolves.toEqual(
      caller,
    );
  });

  it('그 동작 권한이 없으면 403', async () => {
    await expect(
      service.assert(9, 'MN000213', 'delete'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('권한 그룹에 그 메뉴 행이 없으면 403', async () => {
    prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
    await expect(service.assert(9, 'MN000213', 'read')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // 가드는 관리자 세션만 보고 계정 상태는 보지 않는다. 막힌 계정은 여기서 끊는다.
  it('지우지 않은 사용 중 계정만 찾는다 — 없으면 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    await expect(service.assert(9, 'MN000213', 'read')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
      }),
    );
  });

  // 메뉴 코드가 비면 Prisma 가 그 조건을 빼 버려, 아무 메뉴에나 권한이 있으면 통과한다. 메뉴 코드를 표에서
  // 꺼내 넘기는 호출부(/support-posts)가 생겨 판정 함수 한 곳에서 막는다 — 호출부 실수라 500 이다.
  it.each([undefined, ''])(
    '메뉴 코드가 비면(%p) 묻지 않고 던진다',
    async (menuCode) => {
      await expect(
        service.assert(9, menuCode as unknown as string, 'read'),
      ).rejects.not.toBeInstanceOf(ForbiddenException);
      await expect(
        service.assert(9, menuCode as unknown as string, 'read'),
      ).rejects.toThrow('메뉴 코드가 비었습니다');
      expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
      expect(prisma.roleGroupMenu.findFirst).not.toHaveBeenCalled();
    },
  );

  it('그 관리자의 권한 그룹 · 지우지 않은 권한 행 · 지우지 않은 사용 중 메뉴만 본다', async () => {
    await service.assert(9, 'MN000213', 'read');

    expect(prisma.roleGroupMenu.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          roleGroupId: 7,
          isDeleted: false,
          roleGroup: { isDeleted: false },
          menu: { menuCode: 'MN000213', isDeleted: false, status: 'ACTIVE' },
        },
      }),
    );
  });
});
