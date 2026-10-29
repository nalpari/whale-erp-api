import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AdminAuthController } from './admin-auth.controller';
import { USER_TYPES } from './auth.decorators';
import { signedInUserTracker } from './throttle';

// 핸들러에 붙은 경로 · 상태 코드만 본다. 판정은 AdminMyPasswordService.verify 의 spec 이 본다.
describe('AdminAuthController verifyMyPassword', () => {
  const handler = Object.getOwnPropertyDescriptor(
    AdminAuthController.prototype,
    'verifyMyPassword',
  )?.value as object;

  it('POST me/password-verifications 이고 맞으면 204', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'me/password-verifications',
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.NO_CONTENT,
    );
  });

  it('로그인한 관리자 아무나 — BP 마스터로 좁히지 않는다', () =>
    expect(Reflect.getMetadata(USER_TYPES, handler)).toEqual(['admin']));

  // 틀려도 로그인 잠금에 세지 않으므로 추측을 막는 것은 이 한도뿐이다. 빠지거나 축 이름이 틀리면 오류 없이
  // 기본 한도로 돈다 — 메타데이터로 고정한다(키는 @nestjs/throttler 내부 상수).
  it('로그인한 계정 기준 10분 10건 한도를 건다', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITaccount', handler)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLaccount', handler)).toBe(600_000);
    expect(Reflect.getMetadata('THROTTLER:TRACKERaccount', handler)).toBe(
      signedInUserTracker,
    );
    expect(
      Reflect.getMetadata('THROTTLER:SKIPaccount', handler),
    ).toBeUndefined();
  });
});
