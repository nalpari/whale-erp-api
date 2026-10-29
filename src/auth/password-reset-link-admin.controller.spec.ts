import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { IS_PUBLIC, USER_TYPES } from './auth.decorators';
import type { AuthUser } from './auth.types';
import { MENU_PERMISSION, MenuPermissionGuard } from './menu-permission.guard';
import { PasswordResetLinkAdminController } from './password-reset-link-admin.controller';
import { PasswordResetLinkService } from './password-reset-link.service';

/** 핸들러에 적힌 Swagger 응답 — 상태 코드 → { description } */
const responsesOf = (proto: object, method: string) =>
  Reflect.getMetadata(
    'swagger/apiResponse',
    Object.getOwnPropertyDescriptor(proto, method)?.value as object,
  ) as Record<string, { description?: string }>;

describe('PasswordResetLinkAdminController', () => {
  let controller: PasswordResetLinkAdminController;
  let links: { issue: jest.Mock };
  let scope: { canManageStaffAccount: jest.Mock };
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const issued = {
    issuedAt: new Date('2026-10-13T03:00:00Z'),
    expiresAt: new Date('2026-10-14T03:00:00Z'),
  };

  beforeEach(async () => {
    links = { issue: jest.fn().mockResolvedValue(issued) };
    scope = { canManageStaffAccount: jest.fn().mockResolvedValue(true) };
    const module = await Test.createTestingModule({
      controllers: [PasswordResetLinkAdminController],
      providers: [
        { provide: PasswordResetLinkService, useValue: links },
        { provide: AdminScopeService, useValue: scope },
      ],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PasswordResetLinkAdminController);
  });

  // 계정에 조치를 하는 동작이라 퇴직 처리와 같은 수정 권한이다(WHALEERP-177).
  it('직원 정보 관리(MN000005) 수정 권한 가드를 거친다', () => {
    expect(
      Reflect.getMetadata(MENU_PERMISSION, PasswordResetLinkAdminController),
    ).toEqual({ action: 'update' });
    expect(
      Reflect.getMetadata(USER_TYPES, PasswordResetLinkAdminController),
    ).toEqual(['admin']);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PasswordResetLinkAdminController),
    ).toContain(MenuPermissionGuard);
    // 경로에 MENU_PERMISSION · IS_PUBLIC · USER_TYPES 가 붙으면 클래스의 판정을 덮는다(getAllAndOverride).
    const names = Object.getOwnPropertyNames(
      PasswordResetLinkAdminController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(names).toEqual(expect.arrayContaining(['issue']));
    for (const name of names) {
      const handler = Object.getOwnPropertyDescriptor(
        PasswordResetLinkAdminController.prototype,
        name,
      )!.value as object;
      for (const key of [MENU_PERMISSION, IS_PUBLIC, USER_TYPES])
        expect([name, key, Reflect.getMetadata(key, handler)]).toEqual([
          name,
          key,
          undefined,
        ]);
    }
  });

  it('보낸 관리자와 읽은 ID 로 범위를 확인하고 발급 결과를 그대로 돌려준다', async () => {
    await expect(controller.issue(admin, '42')).resolves.toEqual(issued);

    expect(scope.canManageStaffAccount).toHaveBeenCalledWith(9, 42);
    expect(links.issue).toHaveBeenCalledWith(9, 42);
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648', '99999999999'])(
    'ID 가 1..2147483647 밖(%p)이면 범위를 묻기 전에 404',
    async (rawId) => {
      await expect(controller.issue(admin, rawId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(scope.canManageStaffAccount).not.toHaveBeenCalled();
      expect(links.issue).not.toHaveBeenCalled();
    },
  );

  it('경계값 2147483647 은 받는다', async () => {
    await controller.issue(admin, '2147483647');

    expect(links.issue).toHaveBeenCalledWith(9, 2147483647);
  });

  it('관리 범위 밖이면 없는 직원과 같은 404 이고 링크를 보내지 않는다', async () => {
    scope.canManageStaffAccount.mockResolvedValue(false);

    await expect(controller.issue(admin, '42')).rejects.toThrow(
      '직원을 찾을 수 없습니다.',
    );
    expect(links.issue).not.toHaveBeenCalled();
  });

  it('503 은 SMTP · 링크 주소 · 메일 설정 없음, 보내기 전에 막힌 것은 500 으로 문서에 나눈다 — 관리자 웹이 openapi 로 응답을 고른다', () => {
    const responses = responsesOf(
      PasswordResetLinkAdminController.prototype,
      'issue',
    );
    expect(responses['503'].description).toContain('메일 서버');
    expect(responses['500'].description).toContain('템플릿');
  });
});
