import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { MyPayslipsController } from './my-payslips.controller';
import { MyPayslipsService } from './my-payslips.service';
import { PayslipDraftService } from './payslip-draft.service';
import { PayslipListService } from './payslip-list.service';
import { PayslipsController } from './payslips.controller';

describe('PayslipsController · MyPayslipsController', () => {
  let admin: PayslipsController;
  let me: MyPayslipsController;
  let list: { list: jest.Mock; findOne: jest.Mock };
  let mine: { list: jest.Mock; findOne: jest.Mock };
  let draft: {
    candidates: jest.Mock;
    create: jest.Mock;
    bulkCreate: jest.Mock;
  };
  const adminUser = { type: 'admin' as const, id: 9, loginId: 'a', sid: 1 };
  const accountUser = {
    type: 'account' as const,
    id: 3,
    email: 'a@b.c',
    sid: 2,
  };

  beforeEach(async () => {
    list = { list: jest.fn(), findOne: jest.fn() };
    mine = { list: jest.fn(), findOne: jest.fn() };
    draft = { candidates: jest.fn(), create: jest.fn(), bulkCreate: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [PayslipsController, MyPayslipsController],
      providers: [
        { provide: PayslipListService, useValue: list },
        { provide: MyPayslipsService, useValue: mine },
        { provide: PayslipDraftService, useValue: draft },
      ],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    admin = module.get(PayslipsController);
    me = module.get(MyPayslipsController);
  });

  it('관리자 목록 · 상세는 급여명세서 관리(MN000009) 조회 권한 가드를 거친다', () => {
    expect(Reflect.getMetadata(MENU_PERMISSION, PayslipsController)).toEqual({
      menuCode: 'MN000009',
      action: 'read',
    });
    expect(Reflect.getMetadata(USER_TYPES, PayslipsController)).toEqual([
      'admin',
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, PayslipsController)).toContain(
      MenuPermissionGuard,
    );
  });

  it('직원 앱 경로는 직원 근무 앱 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, MyPayslipsController)).toEqual([
      'account',
    ]);
  });

  it('관리자 계정을 쓸 수 없으면 목록 403', async () => {
    list.list.mockResolvedValue(null);
    await expect(
      admin.findAll(adminUser, { month: '2026-09' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('관리자 상세: ID 형식 오류는 서비스를 부르지 않고 404, 없으면 404', async () => {
    await expect(admin.findOne(adminUser, '2147483648')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(list.findOne).not.toHaveBeenCalled();
    list.findOne.mockResolvedValue(null);
    await expect(admin.findOne(adminUser, '40')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(list.findOne).toHaveBeenCalledWith(9, 40);
  });

  it('직원 앱: 로그인한 계정으로 찾고, 없으면 404', async () => {
    mine.list.mockResolvedValue({ items: [] });
    await expect(me.findAll(accountUser)).resolves.toEqual({ items: [] });
    expect(mine.list).toHaveBeenCalledWith(3);
    await expect(me.findOne(accountUser, 'abc')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    mine.findOne.mockResolvedValue(null);
    await expect(me.findOne(accountUser, '40')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mine.findOne).toHaveBeenCalledWith(3, 40);
  });

  it('작성 대상 · 초안 작성 · 일괄 작성은 급여명세서 관리 등록(create) 권한을 본다', () => {
    // 메타데이터만 읽으므로 this 없이 함수 객체를 꺼낸다.
    for (const name of ['candidates', 'create', 'bulkCreate'])
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(PayslipsController.prototype, name)!
            .value as object,
        ),
      ).toEqual({
        menuCode: 'MN000009',
        action: 'create',
      });
  });

  it('관리자 계정을 쓸 수 없으면 작성 대상 · 초안 · 일괄 작성 403', async () => {
    draft.candidates.mockResolvedValue(null);
    draft.create.mockResolvedValue(null);
    draft.bulkCreate.mockResolvedValue(null);
    await expect(
      admin.candidates(adminUser, { month: '2026-10' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      admin.create(adminUser, { staffMemberId: 30, month: '2026-10' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      admin.bulkCreate(adminUser, { month: '2026-10' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('초안 작성 · 일괄 작성은 로그인한 관리자로 서비스를 부른다', async () => {
    draft.create.mockResolvedValue({ payslipId: 100 });
    await expect(
      admin.create(adminUser, { staffMemberId: 30, month: '2026-10' }),
    ).resolves.toEqual({ payslipId: 100 });
    expect(draft.create).toHaveBeenCalledWith(9, 30, '2026-10');
    draft.bulkCreate.mockResolvedValue({ created: [], skipped: [] });
    await expect(
      admin.bulkCreate(adminUser, { month: '2026-10' }),
    ).resolves.toEqual({ created: [], skipped: [] });
    expect(draft.bulkCreate).toHaveBeenCalledWith(9, '2026-10');
  });
});
