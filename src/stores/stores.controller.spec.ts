// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import type { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import type { StoreManagementService } from './store-management.service';
import { StoresController } from './stores.controller';
import type { StoresService } from './stores.service';

const USER: AuthUser = { id: 5, type: 'admin', loginId: 'admin', sid: 1 };
const CALLER = { adminAccountId: 5, roleTypeCode: 'BM', roleGroupId: 2 };

describe('StoresController', () => {
  const options = { options: jest.fn() };
  const management = {
    list: jest.fn(),
    detail: jest.fn(),
    histories: jest.fn(),
    transitionCheck: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    verifyBusiness: jest.fn(),
    putImage: jest.fn(),
    removeImage: jest.fn(),
    excel: jest.fn().mockResolvedValue({
      fileName: '점포목록_20261014.xlsx',
      buffer: Buffer.from('PK'),
    }),
  };
  const permissions = { assert: jest.fn() };
  const controller = new StoresController(
    options as unknown as StoresService,
    management as unknown as StoreManagementService,
    permissions as unknown as MenuPermissionsService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    permissions.assert.mockResolvedValue(CALLER);
  });

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, StoresController)).toEqual([
      'admin',
    ]);
  });

  it('GET /stores/options 는 메뉴 권한 없이 업무 범위로만 거른 근무지 선택지다', async () => {
    const page = { items: [], total: 0 };
    options.options.mockResolvedValue(page);
    await expect(
      controller.options({ page: 1, pageSize: 200 }, USER),
    ).resolves.toBe(page);
    expect(options.options).toHaveBeenCalledWith(5, { page: 1, pageSize: 200 });
    expect(permissions.assert).not.toHaveBeenCalled();
  });

  it.each([
    ['list', () => controller.list(USER, { page: 1, pageSize: 20 }), 'read'],
    ['excel', () => controller.excel(USER, {}), 'read'],
    ['detail', () => controller.detail(USER, '11'), 'read'],
    [
      'histories',
      () => controller.histories(USER, '11', { page: 1, pageSize: 10 }),
      'read',
    ],
    ['transitionCheck', () => controller.transitionCheck(USER, '11'), 'read'],
    ['create', () => controller.create(USER, {} as never), 'create'],
    ['update', () => controller.update(USER, '11', {} as never), 'update'],
    ['remove', () => controller.remove(USER, '11'), 'delete'],
    ['putImage', () => controller.putImage(USER, '11', []), 'update'],
    ['removeImage', () => controller.removeImage(USER, '11'), 'update'],
  ])(
    '%s 은 MN000002 의 %s 권한을 본 뒤 호출자를 넘긴다',
    async (method, call, action) => {
      await call();
      expect(permissions.assert).toHaveBeenCalledWith(5, 'MN000002', action);
      expect(
        management[method as keyof typeof management].mock.calls[0][0],
      ).toBe(CALLER);
    },
  );

  it.each(['0', 'abc', '2147483648', '1.5'])(
    '경로 id %s 는 권한을 묻기 전에 404',
    async (raw) => {
      await expect(controller.detail(USER, raw)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(permissions.assert).not.toHaveBeenCalled();
    },
  );

  it('대표 이미지는 받은 첫 파일을 넘기고, 없으면 undefined 를 넘긴다', async () => {
    const file = { buffer: Buffer.from('x'), size: 1, originalname: 'a.png' };
    await controller.putImage(USER, '11', [file]);
    await controller.putImage(USER, '11', undefined);
    expect(management.putImage.mock.calls[0][2]).toBe(file);
    expect(management.putImage.mock.calls[1][2]).toBeUndefined();
  });

  it('엑셀은 xlsx 형식과 한글 파일 이름(RFC 5987)으로 내려보낸다', async () => {
    const file = await controller.excel(USER, {});
    expect(file.getHeaders()).toMatchObject({
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition:
        "attachment; filename*=UTF-8''%EC%A0%90%ED%8F%AC%EB%AA%A9%EB%A1%9D_20261014.xlsx",
      length: 2,
    });
  });

  describe('사업자 인증 확인', () => {
    const body = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };

    it('등록 권한이면 된다', async () => {
      await controller.verifyBusiness(USER, body);
      expect(permissions.assert).toHaveBeenCalledWith(5, 'MN000002', 'create');
      expect(management.verifyBusiness).toHaveBeenCalledWith(CALLER, body);
    });

    it('등록 권한이 없어도 수정 권한이면 된다', async () => {
      permissions.assert
        .mockRejectedValueOnce(new ForbiddenException())
        .mockResolvedValueOnce(CALLER);
      await controller.verifyBusiness(USER, body);
      expect(permissions.assert).toHaveBeenLastCalledWith(
        5,
        'MN000002',
        'update',
      );
    });

    it('둘 다 없으면 403', async () => {
      permissions.assert.mockRejectedValue(new ForbiddenException());
      await expect(
        controller.verifyBusiness(USER, body),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(management.verifyBusiness).not.toHaveBeenCalled();
    });
  });
});
