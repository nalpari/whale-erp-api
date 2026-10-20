import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { personalDataKeyProvider } from './personal-data-key.provider';

type Factory = (config: ConfigService) => Buffer | null;
const factory = (personalDataKeyProvider as { useFactory: Factory }).useFactory;
const config = (value: string | undefined) =>
  ({ get: () => value }) as unknown as ConfigService;

describe('personalDataKeyProvider', () => {
  const env = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  // 원래 값이 없던 변수에 undefined 를 넣으면 문자열 'undefined' 가 된다 — 지워서 되돌린다.
  const restore = (name: 'APP_ENV' | 'NODE_ENV') => {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  };

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    error.mockRestore();
    warn.mockRestore();
    restore('APP_ENV');
    restore('NODE_ENV');
  });

  it('키가 있으면 그 키, 로그 없음 — 앞뒤 공백은 지운다', () => {
    process.env.APP_ENV = 'prod';
    const key = randomBytes(32);
    expect(factory(config(` ${key.toString('base64')}\n`))).toEqual(key);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('형식이 틀린 키면 던져 기동을 막는다 — null 로 삼키지 않는다', () => {
    expect(() => factory(config(randomBytes(16).toString('base64')))).toThrow(
      /PERSONAL_DATA_ENCRYPTION_KEY/,
    );
  });

  it('운영에서 비어 있으면 뜨기는 하되 error 로그 — 잊은 설정이 신고 정보 503 으로만 드러나지 않게', () => {
    process.env.APP_ENV = 'prod';
    expect(factory(config(''))).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('PERSONAL_DATA_ENCRYPTION_KEY'),
    );
  });

  it('개발 · 로컬에서 비어 있으면 null 과 warn — 빠뜨린 것이 흔적 없이 지나가지 않게', () => {
    process.env.APP_ENV = 'dev';
    process.env.NODE_ENV = 'development';
    expect(factory(config(undefined))).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('PERSONAL_DATA_ENCRYPTION_KEY'),
    );
  });
});
