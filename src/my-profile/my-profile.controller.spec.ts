import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import { API_ENUMS } from '../enums/api-enums';
import { MyProfileController } from './my-profile.controller';
import type { MyProfileService } from './my-profile.service';

describe('MyProfileController', () => {
  it('직원 앱 계정 토큰만 — 관리자 토큰은 가드가 403', () => {
    expect(Reflect.getMetadata(USER_TYPES, MyProfileController)).toEqual([
      'account',
    ]);
    expect(Reflect.getMetadata(IS_PUBLIC, MyProfileController)).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, MyProfileController)).toBe(
      'me/profile',
    );
  });

  it('탈퇴 · 토큰 없음 401 을 Swagger 에 적는다', () => {
    const responses = Reflect.getMetadata(
      'swagger/apiResponse',
      MyProfileController,
    ) as Record<string, unknown>;
    expect(responses).toHaveProperty('401');
    expect(responses).toHaveProperty('403');
  });

  it('경로에 계정 id 를 받지 않고 토큰의 계정으로만 읽는다', async () => {
    const get = jest.fn().mockResolvedValue({ accountId: 12 });
    const controller = new MyProfileController({
      get,
    } as unknown as MyProfileService);
    await controller.get({
      type: 'account',
      id: 12,
      email: 'a@b.c',
      sid: 1,
    } as never);
    expect(get).toHaveBeenCalledWith(12);
  });

  it('위치정보 동의 상태 한글을 GET /enums 로 준다', () => {
    expect(API_ENUMS.LocationConsentState).toEqual([
      ['NOT_AGREED', '미동의'],
      ['AGREED', '동의'],
      ['PAUSED', '일시 중지'],
      ['WITHDRAWN', '철회'],
    ]);
  });
});
