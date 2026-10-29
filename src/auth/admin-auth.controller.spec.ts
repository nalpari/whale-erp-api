import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AdminAuthController } from './admin-auth.controller';
import { USER_TYPES } from './auth.decorators';

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
});
