// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { signedInUserTracker } from '../auth/throttle';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import type { StoreManagementService } from './store-management.service';
import { StoresController } from './stores.controller';
import type { StoresService } from './stores.service';

const USER: AuthUser = { id: 5, type: 'admin', loginId: 'admin', sid: 1 };

describe('StoresController', () => {
  const methodMeta = (key: string, method: keyof StoresController): unknown =>
    Reflect.getMetadata(
      key,
      Object.getOwnPropertyDescriptor(StoresController.prototype, method)
        ?.value as object,
    );

  it('사업자 인증 확인은 IP · 계정마다 시간당 10건이다 — 회원가입과 같은 국세청 하루 할당량을 쓴다', () => {
    expect(methodMeta(GUARDS_METADATA, 'verifyBusiness')).toContain(
      ThrottlerGuard,
    );
    expect(methodMeta('THROTTLER:LIMITip', 'verifyBusiness')).toBe(10);
    expect(methodMeta('THROTTLER:TTLip', 'verifyBusiness')).toBe(3_600_000);
    expect(methodMeta('THROTTLER:LIMITaccount', 'verifyBusiness')).toBe(10);
    expect(methodMeta('THROTTLER:TTLaccount', 'verifyBusiness')).toBe(
      3_600_000,
    );
    expect(methodMeta('THROTTLER:TRACKERaccount', 'verifyBusiness')).toBe(
      signedInUserTracker,
    );
  });

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
  const controller = new StoresController(
    options as unknown as StoresService,
    management as unknown as StoreManagementService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(methodMeta(MENU_PERMISSION, 'options')).toBeUndefined();
    expect(methodMeta(GUARDS_METADATA, 'options')).toBeUndefined();
  });

  // 권한 판정은 가드가 한다 — 파이프 · 인터셉터 · 핸들러보다 먼저 돌아, 권한 없는 요청은 그 어디에도 닿지 않는다.
  it.each([
    ['list', 'read'],
    ['excel', 'read'],
    ['verifyBusiness', ['create', 'update']],
    ['detail', 'read'],
    ['histories', 'read'],
    ['transitionCheck', 'read'],
    ['create', 'create'],
    ['update', 'update'],
    ['remove', 'delete'],
    ['putImage', 'update'],
    ['removeImage', 'update'],
  ] as const)('%s 은 가드가 MN000002 의 %j 권한을 본다', (method, action) => {
    expect(methodMeta(MENU_PERMISSION, method)).toEqual({
      menuCode: 'MN000002',
      action,
    });
    expect(methodMeta(USER_TYPES, method)).toEqual(['admin']);
    expect(methodMeta(GUARDS_METADATA, method)).toContain(MenuPermissionGuard);
  });

  it.each([
    ['list', () => controller.list(USER, { page: 1, pageSize: 20 })],
    ['excel', () => controller.excel(USER, {})],
    ['detail', () => controller.detail(USER, '11')],
    [
      'histories',
      () => controller.histories(USER, '11', { page: 1, pageSize: 10 }),
    ],
    ['transitionCheck', () => controller.transitionCheck(USER, '11')],
    ['create', () => controller.create(USER, {} as never)],
    ['update', () => controller.update(USER, '11', {} as never)],
    ['remove', () => controller.remove(USER, '11')],
    ['verifyBusiness', () => controller.verifyBusiness(USER, {} as never)],
    ['putImage', () => controller.putImage(USER, '11', [])],
    ['removeImage', () => controller.removeImage(USER, '11')],
  ])('%s 은 서비스에 관리자 계정 id 를 넘긴다', async (method, call) => {
    await call();
    expect(management[method as keyof typeof management].mock.calls[0][0]).toBe(
      5,
    );
  });

  it('경로 id 는 숫자로 바꿔 넘긴다', async () => {
    await controller.detail(USER, '11');
    expect(management.detail).toHaveBeenCalledWith(5, 11);
  });

  it.each(['0', 'abc', '2147483648', '1.5'])(
    '경로 id %s 는 서비스에 묻기 전에 404',
    (raw) => {
      expect(() => controller.detail(USER, raw)).toThrow(NotFoundException);
      expect(management.detail).not.toHaveBeenCalled();
    },
  );

  it('대표 이미지는 받은 첫 파일을 넘기고, 없으면 undefined 를 넘긴다', async () => {
    const file = { buffer: Buffer.from('x'), size: 1, originalname: 'a.png' };
    await controller.putImage(USER, '11', [file]);
    await controller.putImage(USER, '11', undefined);
    expect(management.putImage.mock.calls[0][2]).toBe(file);
    expect(management.putImage.mock.calls[1][2]).toBeUndefined();
  });

  it('사업자 인증 확인은 본문을 그대로 넘긴다', async () => {
    const body = {
      bizRegistrationNumber: '1234567890',
      ceoName: '김대표',
      openDate: '2020-03-02',
    };
    await controller.verifyBusiness(USER, body);
    expect(management.verifyBusiness).toHaveBeenCalledWith(5, body);
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
});
