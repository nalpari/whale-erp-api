import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import type { AuthUser } from '../auth/auth.types';
import { CodesService } from '../codes/codes.service';
import { BpCodesController } from './bp-codes.controller';

describe('BpCodesController — 공통코드', () => {
  let controller: BpCodesController;
  let scope: { bpStoresAccess: jest.Mock; bpStoresVersion: jest.Mock };
  let codes: { forBpId: jest.Mock };
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'bm', sid: 1 };
  const staff = { id: 3, type: 'account', email: 'a@b.c', sid: 1 } as AuthUser;

  beforeEach(async () => {
    scope = {
      bpStoresAccess: jest.fn().mockResolvedValue('allowed'),
      bpStoresVersion: jest.fn().mockResolvedValue('v1'),
    };
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

  // 관리자 웹이 새로고침 · 메뉴 이동 · 창 포커스 때 묻는다 — 볼 수 있는 BP 와 오류는 점포 목록과 같다.
  describe('점포 목록 버전(stores-version)', () => {
    it('볼 수 있는 BP 면 버전만 준다', async () => {
      await expect(controller.findStoresVersion(admin, '7')).resolves.toEqual({
        version: 'v1',
      });
      expect(scope.bpStoresAccess).toHaveBeenCalledWith(admin, 7);
      expect(scope.bpStoresVersion).toHaveBeenCalledWith(admin, 7);
    });

    it('볼 수 없는 BP 는 없는 BP 처럼 404 이고 버전을 계산하지 않는다', async () => {
      scope.bpStoresAccess.mockResolvedValue('denied');
      await expect(controller.findStoresVersion(admin, '8')).rejects.toThrow(
        NotFoundException,
      );
      expect(scope.bpStoresVersion).not.toHaveBeenCalled();
    });

    it('없거나 지운 BP · 플랫폼 BP 는 404', async () => {
      scope.bpStoresVersion.mockResolvedValue(null);
      await expect(controller.findStoresVersion(admin, '7')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('사용할 수 없는 관리자 계정은 403', async () => {
      scope.bpStoresAccess.mockResolvedValue('unavailable');
      await expect(controller.findStoresVersion(admin, '7')).rejects.toThrow(
        new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE),
      );
    });

    it('정수 범위 밖이면 묻지 않고 404', async () => {
      await expect(
        controller.findStoresVersion(admin, '2147483648'),
      ).rejects.toThrow(NotFoundException);
      expect(scope.bpStoresAccess).not.toHaveBeenCalled();
    });
  });
});
