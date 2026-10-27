import { HttpStatus, NotFoundException, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { BpAdminsController } from './bp-admins.controller';
import { BpAdminsService } from './bp-admins.service';

describe('BpAdminsController', () => {
  let controller: BpAdminsController;
  let admins: Record<string, jest.Mock>;
  const user: AuthUser = { id: 9, type: 'admin', loginId: 'bm', sid: 1 };
  const bp: TargetBpContext = { bpCodeId: 17, isPlatformCaller: false };

  beforeEach(async () => {
    admins = Object.fromEntries(
      [
        'list',
        'roleGroups',
        'storeOptions',
        'isLoginIdAvailable',
        'isEmailAvailable',
        'detail',
        'histories',
        'updateImpact',
        'create',
        'update',
        'resetPassword',
      ].map((name) => [name, jest.fn().mockResolvedValue(true)]),
    );
    const module = await Test.createTestingModule({
      controllers: [BpAdminsController],
      providers: [{ provide: BpAdminsService, useValue: admins }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(BpAdminsController);
  });

  const handlerOf = (method: keyof BpAdminsController) =>
    Object.getOwnPropertyDescriptor(BpAdminsController.prototype, method)!
      .value as object;

  it('컨트롤러 경로는 bp-admins 다 — 메뉴 BP 관리자 관리(/bp-admins, MN000012)로 판정된다', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BpAdminsController)).toBe(
      'bp-admins',
    );
  });

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, BpAdminsController)).toEqual([
      'admin',
    ]);
  });

  // 삭제 경로는 없다(계정 회수 기능 없음). 확인창 수는 저장 전에 묻는 것이라 수정 권한이다.
  it.each([
    ['list', 'read', RequestMethod.GET, '/'],
    ['roleGroups', 'read', RequestMethod.GET, 'role-groups'],
    ['storeOptions', 'read', RequestMethod.GET, 'store-options'],
    [
      'loginIdAvailability',
      'create',
      RequestMethod.GET,
      'login-id-availability',
    ],
    ['emailAvailability', 'create', RequestMethod.GET, 'email-availability'],
    ['detail', 'read', RequestMethod.GET, ':id'],
    ['histories', 'read', RequestMethod.GET, ':id/histories'],
    ['updateImpact', 'update', RequestMethod.GET, ':id/update-impact'],
    ['create', 'create', RequestMethod.POST, '/'],
    ['update', 'update', RequestMethod.PUT, ':id'],
    ['resetPassword', 'update', RequestMethod.POST, ':id/password-reset'],
  ] as const)('%s 는 %s 권한 · %s %s', (method, action, verb, path) => {
    const handler = handlerOf(method);
    expect(Reflect.getMetadata(MENU_PERMISSION, handler)).toEqual({ action });
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
  });

  it('수정은 본문 없이 204, 비밀번호 초기화는 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('update'))).toBe(
      HttpStatus.NO_CONTENT,
    );
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('resetPassword')),
    ).toBe(HttpStatus.OK);
  });

  it('호출자 · 가드가 정한 BP · 경로 id 를 넘긴다', async () => {
    await controller.detail(user, bp, '15');
    expect(admins.detail).toHaveBeenCalledWith(9, bp, 15);
  });

  it.each(['0', '2147483648', 'abc', '1.5'])(
    '경로 id %p 는 DB 에 묻기 전에 404',
    (raw) => {
      expect(() => controller.detail(user, bp, raw)).toThrow(NotFoundException);
      expect(admins.detail).not.toHaveBeenCalled();
    },
  );

  it('아이디 중복 확인은 { available } 로 답한다', async () => {
    await expect(
      controller.loginIdAvailability({ loginId: 'jisu01' }),
    ).resolves.toEqual({ available: true });
  });

  it('이메일 중복 확인은 { available } 로 답한다', async () => {
    admins.isEmailAvailable.mockResolvedValue(false);
    await expect(
      controller.emailAvailability({ email: 'jisu@whale.test' }),
    ).resolves.toEqual({ available: false });
    expect(admins.isEmailAvailable).toHaveBeenCalledWith('jisu@whale.test');
  });
});
