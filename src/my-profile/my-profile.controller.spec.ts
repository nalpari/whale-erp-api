import { PATH_METADATA } from '@nestjs/common/constants';
import {
  THROTTLER_LIMIT,
  THROTTLER_TRACKER,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC, USER_TYPES } from '../auth/auth.decorators';
import { AUTH_THROTTLERS, signedInUserTracker } from '../auth/throttle';
import { API_ENUMS } from '../enums/api-enums';
import { MyProfileController } from './my-profile.controller';
import type { MyAddressService } from './my-address.service';
import type { MyEmailChangeService } from './my-email-change.service';
import type { MyPasswordService } from './my-password.service';
import type { MyProfileService } from './my-profile.service';

const me = { type: 'account', id: 12, email: 'a@b.c', sid: 31 } as never;

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
    const controller = new MyProfileController(
      { get } as unknown as MyProfileService,
      {} as MyAddressService,
      {} as MyPasswordService,
      {} as MyEmailChangeService,
    );
    await controller.get(me);
    expect(get).toHaveBeenCalledWith(12);
  });

  it('주소는 토큰의 계정에 저장한다 (WHALEERP-189)', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const controller = new MyProfileController(
      {} as MyProfileService,
      { update } as unknown as MyAddressService,
      {} as MyPasswordService,
      {} as MyEmailChangeService,
    );
    const body = { zipCode: '04524', address: '서울 중구 세종대로 110' };
    await controller.updateAddress(me, body);
    expect(update).toHaveBeenCalledWith(12, body);
  });

  it('비밀번호 변경은 토큰의 계정과 이 접속을 넘긴다 — 이 기기만 남긴다 (WHALEERP-192)', async () => {
    const change = jest.fn().mockResolvedValue(undefined);
    const controller = new MyProfileController(
      {} as MyProfileService,
      {} as MyAddressService,
      { change } as unknown as MyPasswordService,
      {} as MyEmailChangeService,
    );
    await controller.changePassword(me, {
      currentPassword: 'OldPass123!',
      newPassword: 'NewPass456!',
    });
    expect(change).toHaveBeenCalledWith(
      { id: 12, sid: 31 },
      'OldPass123!',
      'NewPass456!',
    );
  });

  it.each(['changePassword', 'requestEmailChangePin', 'changeEmail'])(
    '%s 는 로그인한 계정마다 10분에 10번 — 비밀번호 · 핀 대입과 메일 남발을 늦춘다',
    (method) => {
      const handler = Object.getOwnPropertyDescriptor(
        MyProfileController.prototype,
        method,
      )?.value as object;
      const meta = (key: string) =>
        Reflect.getMetadata(`${key}account`, handler) as unknown;
      expect(
        Reflect.getMetadata('__guards__', handler) as unknown[],
      ).toHaveLength(1);
      expect(meta(THROTTLER_LIMIT)).toBe(10);
      expect(meta(THROTTLER_TTL)).toBe(600_000);
      // 기본 계정 축은 본문 이메일 · 토큰으로 세 토큰을 갈아 끼우면 새 버킷이 된다 — 계정 id 로 센다
      expect(meta(THROTTLER_TRACKER)).toBe(signedInUserTracker);
      // 이름이 모듈의 축 이름과 같아야 한다 — 다르면 이 한도는 아무 축에도 붙지 않는다
      expect(AUTH_THROTTLERS.map((t) => t.name)).toContain('account');
    },
  );

  it('이메일 변경은 토큰의 계정으로 — 핀 요청은 새 이메일, 변경은 핀만 받는다 (WHALEERP-191)', async () => {
    const requestPin = jest.fn().mockResolvedValue(undefined);
    const confirm = jest.fn().mockResolvedValue(undefined);
    const controller = new MyProfileController(
      {} as MyProfileService,
      {} as MyAddressService,
      {} as MyPasswordService,
      { requestPin, confirm } as unknown as MyEmailChangeService,
    );
    await controller.requestEmailChangePin(me, { newEmail: 'new@example.com' });
    await controller.changeEmail(me, { pin: 'A7K2Q9' });
    expect(requestPin).toHaveBeenCalledWith(12, 'new@example.com');
    expect(confirm).toHaveBeenCalledWith(12, 'A7K2Q9');
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
