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
import { BpCodeGroupsController } from './bp-code-groups.controller';
import { BpCodeGroupsService } from './bp-code-groups.service';

describe('BpCodeGroupsController', () => {
  let controller: BpCodeGroupsController;
  let codes: Record<
    'listGroups' | 'listItems' | 'createItems' | 'updateItems' | 'deleteItems',
    jest.Mock
  >;
  const admin: AuthUser = { id: 9, type: 'admin', loginId: 'bm', sid: 1 };
  const bp: TargetBpContext = { bpCodeId: 17, isPlatformCaller: false };
  const itemRow = {
    itemCode: 'INTERN',
    label: '수습',
    status: 'ACTIVE' as const,
    sortOrder: 5,
  };

  beforeEach(async () => {
    codes = {
      listGroups: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listItems: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      createItems: jest.fn().mockResolvedValue(undefined),
      updateItems: jest.fn().mockResolvedValue(undefined),
      deleteItems: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      controllers: [BpCodeGroupsController],
      providers: [{ provide: BpCodeGroupsService, useValue: codes }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(BpCodeGroupsController);
  });

  const handlerOf = (method: keyof BpCodeGroupsController) =>
    Object.getOwnPropertyDescriptor(BpCodeGroupsController.prototype, method)!
      .value as object;

  // 메뉴는 경로(/bp-code-groups, MN000014)로 찾는다. 플랫폼 사용자도 조회는 하므로 platformOnly 가 아니다.
  it.each([
    ['listGroups', 'read'],
    ['listItems', 'read'],
    ['createItems', 'create'],
    ['updateItems', 'update'],
    ['deleteItems', 'delete'],
  ] as const)('%s 는 경로 메뉴의 %s 권한으로 표시돼 있다', (method, action) => {
    expect(Reflect.getMetadata(MENU_PERMISSION, handlerOf(method))).toEqual({
      action,
    });
  });

  it('컨트롤러 경로는 bp-code-groups 다', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BpCodeGroupsController)).toBe(
      'bp-code-groups',
    );
  });

  // 등록은 POST, 수정은 PUT 으로 나뉘고(플랫폼 공통코드 관리와 같다) 둘 다 본문 없이 204.
  it.each([
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

  it('목록은 가드가 정한 BP 와 검색 조건을 넘긴다', async () => {
    const query = { page: 1, pageSize: 20, groupName: '고용' };
    await controller.listGroups(bp, query);

    expect(codes.listGroups).toHaveBeenCalledWith(bp, query);
  });

  it('등록 · 수정은 저장한 관리자 · BP · 그룹 코드 · items 를 따로 넘긴다', async () => {
    await controller.createItems(admin, bp, 'EMP_TYPE', { items: [itemRow] });
    expect(codes.createItems).toHaveBeenCalledWith(9, bp, 'EMP_TYPE', [
      itemRow,
    ]);
    expect(codes.updateItems).not.toHaveBeenCalled();

    await controller.updateItems(admin, bp, 'EMP_TYPE', { items: [itemRow] });
    expect(codes.updateItems).toHaveBeenCalledWith(9, bp, 'EMP_TYPE', [
      itemRow,
    ]);
  });

  it('삭제는 저장한 관리자 · BP · 그룹 코드 · itemCodes 를 넘긴다', async () => {
    await controller.deleteItems(admin, bp, 'emp_type', {
      itemCodes: ['INTERN'],
    });

    expect(codes.deleteItems).toHaveBeenCalledWith(9, bp, 'EMP_TYPE', [
      'INTERN',
    ]);
  });

  it.each(['emp_type', ' EMP_TYPE '])(
    '경로의 그룹 코드 %p 는 EMP_TYPE 으로 받는다',
    async (groupCode) => {
      await controller.listItems(bp, groupCode);

      expect(codes.listItems).toHaveBeenCalledWith(bp, 'EMP_TYPE');
    },
  );

  it.each(['1ABC', 'A'.repeat(21), 'EMP-TYPE'])(
    '경로의 그룹 코드 형식이 틀리면(%p) DB 에 묻기 전에 404',
    async (groupCode) => {
      const body = { items: [itemRow] };
      await expect(controller.listItems(bp, groupCode)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        controller.createItems(admin, bp, groupCode, body),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.updateItems(admin, bp, groupCode, body),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.deleteItems(admin, bp, groupCode, { itemCodes: ['FULL'] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(codes.listItems).not.toHaveBeenCalled();
      expect(codes.createItems).not.toHaveBeenCalled();
      expect(codes.updateItems).not.toHaveBeenCalled();
      expect(codes.deleteItems).not.toHaveBeenCalled();
    },
  );

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, BpCodeGroupsController)).toEqual([
      'admin',
    ]);
  });
});
