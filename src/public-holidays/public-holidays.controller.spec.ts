import { Test } from '@nestjs/testing';
import { USER_TYPES } from '../auth/auth.decorators';
import {
  MENU_PERMISSION,
  MenuPermissionGuard,
} from '../auth/menu-permission.guard';
import { PublicHolidaysController } from './public-holidays.controller';
import { PublicHolidaysService } from './public-holidays.service';

describe('PublicHolidaysController', () => {
  let controller: PublicHolidaysController;
  let holidays: Record<string, jest.Mock>;

  beforeEach(async () => {
    holidays = { list: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
    const module = await Test.createTestingModule({
      controllers: [PublicHolidaysController],
      providers: [{ provide: PublicHolidaysService, useValue: holidays }],
    })
      // 가드의 판정은 menu-permission.guard.spec 과 e2e 가 본다. 여기서는 붙어 있는지만 본다.
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PublicHolidaysController);
  });

  it('관리자 토큰만 받는다', () => {
    expect(Reflect.getMetadata(USER_TYPES, PublicHolidaysController)).toEqual([
      'admin',
    ]);
  });

  // 메뉴 권한 · 플랫폼 BP 의 PM · PA 판정은 가드가 한다 — 여기서는 표시만 본다.
  it('조회는 메뉴(경로로 찾는 MN000217) 조회 권한 · 플랫폼 관리자 전용으로 표시돼 있다', () => {
    expect(
      Reflect.getMetadata(
        MENU_PERMISSION,
        Object.getOwnPropertyDescriptor(
          PublicHolidaysController.prototype,
          'list',
        )!.value as object,
      ),
    ).toEqual({ action: 'read', platformOnly: true });
  });

  it('등록 · 수정 · 삭제 경로는 없다 — 공식 휴일은 규칙 계산과 동기화로만 바뀐다', () => {
    const methods = Object.getOwnPropertyNames(
      PublicHolidaysController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['list']);
  });

  it('쿼리를 서비스에 넘긴다', async () => {
    await controller.list({ year: 2026, month: 9 });
    expect(holidays.list).toHaveBeenCalledWith({ year: 2026, month: 9 });
  });
});
