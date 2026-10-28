import { NotFoundException, StreamableFile } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { USER_TYPES } from '../auth/auth.decorators';
import { signedInUserTracker } from '../auth/throttle';
import type { AuthUser } from '../auth/auth.types';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { BpMastersController } from './bp-masters.controller';
import { BpMastersService } from './bp-masters.service';

describe('BpMastersController', () => {
  let controller: BpMastersController;
  let bpMasters: Record<
    | 'list'
    | 'excel'
    | 'detail'
    | 'histories'
    | 'isLoginIdAvailable'
    | 'isEmailAvailable'
    | 'verifyBusiness'
    | 'create'
    | 'update'
    | 'changeStatus'
    | 'resetPassword'
    | 'remove',
    jest.Mock
  >;
  const user: AuthUser = { id: 9, type: 'admin', loginId: 'admin', sid: 1 };
  const page = { page: 1, pageSize: 20 };
  const body = {
    name: '김하늘',
    phone: '01012345678',
    email: 'ceo@hangang.test',
    tradeName: '한강상회',
  };
  const identity = {
    bizRegistrationNumber: '1058763602',
    bizCeoName: '김하늘',
    bizOpenDate: '2020-03-02',
  };

  beforeEach(async () => {
    bpMasters = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      excel: jest.fn().mockResolvedValue({
        fileName: 'BP목록_20261023.xlsx',
        buffer: Buffer.from('x'),
      }),
      detail: jest.fn().mockResolvedValue({}),
      histories: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      isLoginIdAvailable: jest.fn().mockResolvedValue(true),
      isEmailAvailable: jest.fn().mockResolvedValue(true),
      verifyBusiness: jest.fn().mockResolvedValue({ verificationToken: 't' }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue(undefined),
      changeStatus: jest.fn().mockResolvedValue(undefined),
      resetPassword: jest.fn().mockResolvedValue({ isMailSent: true }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      controllers: [BpMastersController],
      providers: [{ provide: BpMastersService, useValue: bpMasters }],
    })
      // 가드는 따로 시험한다(menu-permission.guard.spec). 여기서는 붙은 표시만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(BpMastersController);
  });

  // 메뉴는 경로 첫 단계(/bp-masters = MN000203)로 정해진다. 플랫폼 계정만 쓴다.
  it.each([
    ['list', 'read'],
    ['excel', 'read'],
    ['detail', 'read'],
    ['histories', 'read'],
    ['loginIdAvailability', 'create'],
    ['emailAvailability', 'create'],
    ['verifyBusiness', ['create', 'update']],
    ['create', 'create'],
    ['update', 'update'],
    ['changeStatus', 'update'],
    ['resetPassword', 'update'],
    ['remove', 'delete'],
  ] as const)(
    '%s 는 %p 권한과 플랫폼 계정을 가드로 요구한다',
    (method, action) => {
      expect(
        Reflect.getMetadata(
          MENU_PERMISSION,
          Object.getOwnPropertyDescriptor(BpMastersController.prototype, method)
            ?.value as object,
        ),
      ).toEqual({ action, platformOnly: true });
    },
  );

  it('호출자는 id 만 넘기고, 경로의 id 는 숫자로 바꿔 넘긴다', async () => {
    await controller.list(page);
    await controller.detail('12');
    await controller.histories('12', page);
    await controller.loginIdAvailability({ loginId: 'hangang01' });
    await controller.emailAvailability({ email: 'ceo@hangang.kr' });
    await controller.verifyBusiness(user, identity);
    await controller.create(user, { ...body, loginId: 'hangang01' });
    await controller.update(user, '12', body);
    await controller.changeStatus(user, '12', { status: 'INACTIVE' });
    await controller.resetPassword(user, '12');
    await controller.remove(user, '12');

    expect(bpMasters.list).toHaveBeenCalledWith(page);
    expect(bpMasters.detail).toHaveBeenCalledWith(12);
    expect(bpMasters.histories).toHaveBeenCalledWith(12, page);
    expect(bpMasters.isLoginIdAvailable).toHaveBeenCalledWith('hangang01');
    expect(bpMasters.isEmailAvailable).toHaveBeenCalledWith('ceo@hangang.kr');
    expect(bpMasters.verifyBusiness).toHaveBeenCalledWith(9, identity);
    expect(bpMasters.create).toHaveBeenCalledWith(9, {
      ...body,
      loginId: 'hangang01',
    });
    expect(bpMasters.update).toHaveBeenCalledWith(9, 12, body);
    expect(bpMasters.changeStatus).toHaveBeenCalledWith(9, 12, 'INACTIVE');
    expect(bpMasters.resetPassword).toHaveBeenCalledWith(9, 12);
    expect(bpMasters.remove).toHaveBeenCalledWith(9, 12);
  });

  it('엑셀은 파일 이름을 붙여 xlsx 로 돌려준다', async () => {
    const file = await controller.excel(user, { statuses: ['ACTIVE'] });
    expect(bpMasters.excel).toHaveBeenCalledWith(9, { statuses: ['ACTIVE'] });
    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getHeaders().disposition).toContain('.xlsx');
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648'])(
    'id 가 %p 면 DB 에 묻기 전에 404',
    async (id) => {
      await expect(async () => controller.detail(id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(controller.remove(user, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(bpMasters.detail).not.toHaveBeenCalled();
      expect(bpMasters.remove).not.toHaveBeenCalled();
    },
  );

  it('사업자 진위확인은 IP · 계정마다 시간당 10건이다 — 국세청 하루 할당량을 함께 쓴다', () => {
    const meta = (key: string): unknown =>
      Reflect.getMetadata(
        key,
        Object.getOwnPropertyDescriptor(
          BpMastersController.prototype,
          'verifyBusiness',
        )?.value as object,
      );
    expect(meta(GUARDS_METADATA)).toContain(ThrottlerGuard);
    expect(meta('THROTTLER:LIMITip')).toBe(10);
    expect(meta('THROTTLER:TTLip')).toBe(3_600_000);
    expect(meta('THROTTLER:LIMITaccount')).toBe(10);
    expect(meta('THROTTLER:TRACKERaccount')).toBe(signedInUserTracker);
  });

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, BpMastersController)).toEqual([
      'admin',
    ]);
  });
});
