import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  requireStorage,
  STORAGE,
  StorageModule,
  type OptionalStorage,
} from './storage.module';
import { StorageService } from './storage.service';

async function resolve(env: Record<string, string>): Promise<OptionalStorage> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => env],
      }),
      StorageModule,
    ],
  }).compile();
  return moduleRef.get<OptionalStorage>(STORAGE);
}

describe('StorageModule', () => {
  it('설정이 없으면 null 로 뜬다', async () => {
    expect(await resolve({})).toBeNull();
  });

  it('설정이 있으면 StorageService 다', async () => {
    expect(
      await resolve({
        AWS_S3_BUCKET: 'whale-erp-files',
        AWS_S3_REGION: 'ap-northeast-2',
      }),
    ).toBeInstanceOf(StorageService);
  });

  it('하나만 있으면 기동 단계에서 던진다', async () => {
    await expect(resolve({ AWS_S3_BUCKET: 'whale-erp-files' })).rejects.toThrow(
      'AWS_S3_REGION',
    );
  });
});

describe('requireStorage', () => {
  it('null 이면 503', () => {
    expect(() => requireStorage(null)).toThrow(ServiceUnavailableException);
  });
});
