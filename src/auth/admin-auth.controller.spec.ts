import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AdminAuthController } from './admin-auth.controller';
import { ALLOW_PASSWORD_CHANGE_PENDING, USER_TYPES } from './auth.decorators';
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

// 로그인 정보의 stores 만 가볍게 — 점포 목록 버전이 바뀌었을 때 관리자 웹이 부른다.
describe('AdminAuthController getMyStores', () => {
  const handler = Object.getOwnPropertyDescriptor(
    AdminAuthController.prototype,
    'getMyStores',
  )?.value as object;

  it('GET me/stores, 관리자 토큰만', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('me/stores');
    expect(Reflect.getMetadata(USER_TYPES, handler)).toEqual(['admin']);
  });

  it('버전 경로와 같이 강제 비밀번호 변경 중에는 막고, 요청 제한은 끈다', () => {
    expect(
      Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_PENDING, handler),
    ).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:SKIPip', handler)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:SKIPaccount', handler)).toBe(true);
  });
});
