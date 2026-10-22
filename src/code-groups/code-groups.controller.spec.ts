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
} from '../auth/menu-permission.guard';
import { CodeGroupsController } from './code-groups.controller';
import { CodeGroupsService } from './code-groups.service';

describe('CodeGroupsController', () => {
  let controller: CodeGroupsController;
  let codes: Record<
    | 'listGroups'
    | 'createGroups'
    | 'updateGroups'
    | 'listItems'
    | 'createItems'
    | 'updateItems'
    | 'deleteItems'
    | 'applyToBps',
    jest.Mock
  >;
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };

  beforeEach(async () => {
    codes = {
      listGroups: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      createGroups: jest.fn().mockResolvedValue(undefined),
      updateGroups: jest.fn().mockResolvedValue(undefined),
      listItems: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      createItems: jest.fn().mockResolvedValue(undefined),
      updateItems: jest.fn().mockResolvedValue(undefined),
      deleteItems: jest.fn().mockResolvedValue(undefined),
      applyToBps: jest
        .fn()
        .mockResolvedValue({ bpCount: 0, itemCount: 0, createdCount: 0 }),
    };
    const module = await Test.createTestingModule({
      controllers: [CodeGroupsController],
      providers: [{ provide: CodeGroupsService, useValue: codes }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(CodeGroupsController);
  });

  const groupRow = {
    groupCode: 'EMP_TYPE',
    groupName: '고용 형태',
    manageOwnerCode: 'PLATFORM_PROVIDED' as const,
    status: 'ACTIVE' as const,
    sortOrder: 1,
  };
  const groupUpdate = {
    groupCode: 'EMP_TYPE',
    groupName: '고용 형태',
    status: 'ACTIVE' as const,
    sortOrder: 1,
  };
  const itemRow = {
    itemCode: 'FULL',
    label: '정직원',
    status: 'ACTIVE' as const,
    sortOrder: 1,
  };

  const handlerOf = (method: keyof CodeGroupsController) =>
    Object.getOwnPropertyDescriptor(CodeGroupsController.prototype, method)!
      .value as object;

  // 메뉴 MN000216(플랫폼 공통코드 관리). 조회는 read, 등록은 create, 수정 · BP 적용은 update — 플랫폼 관리자 전용.
  it.each([
    ['listGroups', 'read'],
    ['listItems', 'read'],
    ['createGroups', 'create'],
    ['updateGroups', 'update'],
    ['createItems', 'create'],
    ['updateItems', 'update'],
    ['deleteItems', 'delete'],
    ['applyToBps', 'update'],
  ] as const)(
    '%s 는 MN000216 %s 권한 · 플랫폼 관리자 전용으로 표시돼 있다',
    (method, action) => {
      expect(Reflect.getMetadata(MENU_PERMISSION, handlerOf(method))).toEqual({
        action,
        platformOnly: true,
      });
    },
  );

  // 등록은 POST, 수정은 PUT 이고 둘 다 본문 없이 204 — 돌려줄 생성 id 가 없다.
  it.each([
    ['createGroups', RequestMethod.POST, '/'],
    ['updateGroups', RequestMethod.PUT, '/'],
    ['createItems', RequestMethod.POST, ':groupCode/items'],
    ['updateItems', RequestMethod.PUT, ':groupCode/items'],
    ['deleteItems', RequestMethod.DELETE, ':groupCode/items'],
  ] as const)('%s 는 %s %s 이고 204', (method, verb, path) => {
    const handler = handlerOf(method);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  it('그룹 등록은 저장한 관리자와 본문의 items 를 넘긴다', async () => {
    await controller.createGroups(admin, { items: [groupRow] });

    expect(codes.createGroups).toHaveBeenCalledWith(9, [groupRow]);
    expect(codes.updateGroups).not.toHaveBeenCalled();
  });

  it('그룹 수정은 저장한 관리자와 본문의 items 를 넘긴다', async () => {
    await controller.updateGroups(admin, { items: [groupUpdate] });

    expect(codes.updateGroups).toHaveBeenCalledWith(9, [groupUpdate]);
    expect(codes.createGroups).not.toHaveBeenCalled();
  });

  it('상세 코드 등록은 저장한 관리자 · 그룹 코드 · items 를 넘긴다', async () => {
    await controller.createItems(admin, 'EMP_TYPE', { items: [itemRow] });

    expect(codes.createItems).toHaveBeenCalledWith(9, 'EMP_TYPE', [itemRow]);
    expect(codes.updateItems).not.toHaveBeenCalled();
  });

  it('상세 코드 수정은 저장한 관리자 · 그룹 코드 · items 를 넘긴다', async () => {
    await controller.updateItems(admin, 'EMP_TYPE', { items: [itemRow] });

    expect(codes.updateItems).toHaveBeenCalledWith(9, 'EMP_TYPE', [itemRow]);
    expect(codes.createItems).not.toHaveBeenCalled();
  });

  it('상세 코드 삭제는 저장한 관리자 · 그룹 코드 · itemCodes 를 넘긴다', async () => {
    await controller.deleteItems(admin, 'emp_type', { itemCodes: ['FULL'] });

    expect(codes.deleteItems).toHaveBeenCalledWith(9, 'EMP_TYPE', ['FULL']);
  });

  // 본문의 코드와 같은 정책 — 소문자 · 앞뒤 공백은 고쳐 받는다.
  it.each(['emp_type', ' EMP_TYPE '])(
    '경로의 그룹 코드 %p 는 EMP_TYPE 으로 받는다',
    async (groupCode) => {
      const body = { items: [itemRow] };
      await controller.listItems(groupCode);
      await controller.createItems(admin, groupCode, body);
      await controller.updateItems(admin, groupCode, body);
      await controller.applyToBps(admin, groupCode);

      expect(codes.listItems).toHaveBeenCalledWith('EMP_TYPE');
      expect(codes.createItems).toHaveBeenCalledWith(9, 'EMP_TYPE', [itemRow]);
      expect(codes.updateItems).toHaveBeenCalledWith(9, 'EMP_TYPE', [itemRow]);
      expect(codes.applyToBps).toHaveBeenCalledWith(9, 'EMP_TYPE');
    },
  );

  it.each(['1ABC', 'A'.repeat(21), 'EMP-TYPE', '가나'])(
    '경로의 그룹 코드 형식이 틀리면(%p) DB 에 묻기 전에 404',
    async (groupCode) => {
      await expect(controller.listItems(groupCode)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        controller.createItems(admin, groupCode, { items: [itemRow] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.updateItems(admin, groupCode, { items: [itemRow] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(codes.listItems).not.toHaveBeenCalled();
      expect(codes.createItems).not.toHaveBeenCalled();
      expect(codes.updateItems).not.toHaveBeenCalled();
    },
  );

  // 경로마다 가드가 같은 표시를 붙이지만, 가드를 빠뜨린 경로가 더해져도 직원 앱 토큰에 열리지 않게 클래스에도 둔다.
  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, CodeGroupsController)).toEqual([
      'admin',
    ]);
  });
});
