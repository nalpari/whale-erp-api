import { PATH_METADATA } from '@nestjs/common/constants';
import { USER_TYPES } from '../auth/auth.decorators';
import { MyConsentController } from './my-consent.controller';
import type { MyConsentService } from './my-consent.service';

const me = { type: 'account', id: 12, email: 'a@b.c', sid: 31 } as never;

/** 핸들러에 적힌 Swagger 응답 — 상태 코드 → { description } */
const responsesOf = (proto: object, method: string) =>
  Reflect.getMetadata(
    'swagger/apiResponse',
    Object.getOwnPropertyDescriptor(proto, method)?.value as object,
  ) as Record<string, { description?: string }>;

describe('MyConsentController', () => {
  it('직원 앱 계정 토큰만 — 관리자 토큰은 가드가 403', () => {
    expect(Reflect.getMetadata(USER_TYPES, MyConsentController)).toEqual([
      'account',
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, MyConsentController)).toBe('me');
  });

  it.each([
    ['agreeLocation', 'location-consent'],
    ['pauseLocation', 'location-consent/pause'],
    ['resumeLocation', 'location-consent/resume'],
    ['withdrawLocation', 'location-consent/withdraw'],
    ['agreeHqSharing', 'hq-sharing-consent'],
    ['withdrawHqSharing', 'hq-sharing-consent/withdraw'],
  ] as const)(
    '%s 는 POST /me/%s 이고 토큰의 계정으로만 부른다',
    async (method, path) => {
      const fn = jest.fn().mockResolvedValue(undefined);
      const controller = new MyConsentController({
        [method]: fn,
      } as unknown as MyConsentService);
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          Object.getOwnPropertyDescriptor(MyConsentController.prototype, method)
            ?.value as object,
        ),
      ).toBe(path);
      await controller[method](me);
      expect(fn).toHaveBeenCalledWith(12);
    },
  );

  it('위치정보 동의는 시행 중인 약관이 없을 때의 500 을 문서에 적는다', () => {
    expect(
      responsesOf(MyConsentController.prototype, 'agreeLocation')['500']
        .description,
    ).toContain('약관');
  });
});
