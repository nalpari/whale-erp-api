import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import type { AuthUser } from '../auth/auth.types';
import { CodesService } from '../codes/codes.service';
import { BpCodesController } from './bp-codes.controller';

describe('BpCodesController — 공통코드', () => {
  let controller: BpCodesController;
  let scope: { bpStoresAccess: jest.Mock };
  let codes: { forBpId: jest.Mock };
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'bm', sid: 1 };
  const staff = { id: 3, type: 'account', email: 'a@b.c', sid: 1 } as AuthUser;

  beforeEach(async () => {
    scope = { bpStoresAccess: jest.fn().mockResolvedValue('allowed') };
    codes = { forBpId: jest.fn().mockResolvedValue({ STORE_TYPE: [] }) };
    const module = await Test.createTestingModule({
      controllers: [BpCodesController],
      providers: [
        { provide: AdminScopeService, useValue: scope },
        { provide: CodesService, useValue: codes },
      ],
    }).compile();
    controller = module.get(BpCodesController);
  });

  it.each([admin, staff])(
    '볼 수 있는 BP 면 그 BP 의 공통코드 — 관리자 · 직원 앱 모두 bpStoresAccess 로 본다',
    async (user) => {
      await expect(
        controller.findCodeItems(user, '7', { groups: ['STORE_TYPE'] }),
      ).resolves.toEqual({ codes: { STORE_TYPE: [] } });
      expect(scope.bpStoresAccess).toHaveBeenCalledWith(user, 7);
      expect(codes.forBpId).toHaveBeenCalledWith(7, ['STORE_TYPE']);
    },
  );

  it('남의 BP 는 없는 BP 처럼 404 이고 공통코드를 읽지 않는다', async () => {
    scope.bpStoresAccess.mockResolvedValue('denied');
    await expect(controller.findCodeItems(staff, '8', {})).rejects.toThrow(
      NotFoundException,
    );
    expect(codes.forBpId).not.toHaveBeenCalled();
  });

  it('사용할 수 없는 관리자 계정은 403', async () => {
    scope.bpStoresAccess.mockResolvedValue('unavailable');
    await expect(controller.findCodeItems(admin, '7', {})).rejects.toThrow(
      new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
    );
  });

  it('정수 범위 밖이면 묻지 않고 404', async () => {
    await expect(
      controller.findCodeItems(admin, '2147483648', {}),
    ).rejects.toThrow(NotFoundException);
    expect(scope.bpStoresAccess).not.toHaveBeenCalled();
  });
});
