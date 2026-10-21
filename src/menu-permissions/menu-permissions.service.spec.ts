import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { PrismaService } from '../prisma/prisma.service';
import { MenuPermissionsService } from './menu-permissions.service';

describe('MenuPermissionsService', () => {
  let service: MenuPermissionsService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
  };

  // 사용 중이고 지우지 않은 PA, 권한 그룹 7
  const caller = { adminAccountId: 9, roleTypeCode: 'PA', roleGroupId: 7 };

  beforeEach(async () => {
    prisma = {
      adminAccount: { findFirst: jest.fn().mockResolvedValue(caller) },
    };
    const module = await Test.createTestingModule({
      providers: [
        MenuPermissionsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(MenuPermissionsService);
  });

  describe('caller — 메뉴 권한 가드를 통과한 뒤 서비스가 호출자를 읽는다', () => {
    it('지우지 않은 사용 중 계정의 권한 유형 · 권한 그룹을 돌려준다', async () => {
      await expect(service.caller(9)).resolves.toEqual(caller);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          adminAccountId: 9,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: { adminAccountId: true, roleTypeCode: true, roleGroupId: true },
      });
    });

    it('가드와 서비스 사이에 계정을 쓸 수 없게 됐으면 계정 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.caller(9)).rejects.toThrow(
        new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
      );
    });
  });
});
