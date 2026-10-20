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

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    error.mockRestore();
    process.env.APP_ENV = env.APP_ENV;
    process.env.NODE_ENV = env.NODE_ENV;
  });

  it('키가 있으면 그 키, 로그 없음', () => {
    process.env.APP_ENV = 'prod';
    const key = randomBytes(32);
    expect(factory(config(key.toString('base64')))).toEqual(key);
    expect(error).not.toHaveBeenCalled();
  });

  it('운영에서 비어 있으면 뜨기는 하되 error 로그 — 잊은 설정이 신고 정보 503 으로만 드러나지 않게', () => {
    process.env.APP_ENV = 'prod';
    expect(factory(config(''))).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('PERSONAL_DATA_ENCRYPTION_KEY'),
    );
  });

  it('개발 · 로컬에서 비어 있으면 조용히 null', () => {
    process.env.APP_ENV = 'local';
    process.env.NODE_ENV = 'test';
    expect(factory(config(undefined))).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });
});
