import { S3Client } from '@aws-sdk/client-s3';
import { Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readOptionalStorageConfig } from './storage.config';
import { StorageService } from './storage.service';

/** `AWS_S3_*` 가 없으면 null 인 StorageService. */
export const STORAGE = Symbol('STORAGE');

/** STORAGE 로 주입받는 값. null 이면 첨부 기능을 쓸 수 없다 — requireStorage 로 503 을 낸다. */
export type OptionalStorage = StorageService | null;

/** 첨부를 다루는 요청의 첫 줄에서 부른다. 저장소 설정이 없는 환경이면 503. */
export function requireStorage(storage: OptionalStorage): StorageService {
  if (!storage)
    throw new ServiceUnavailableException(
      '첨부파일 저장소가 설정되지 않았습니다.',
    );
  return storage;
}

/** S3 연결 · 요청 제한 시간. 10MB 한 개를 올리는 데 충분하고, 날인본 둘이 계약 쓰기 트랜잭션 60초 안에 끝나는 값. */
const S3_CONNECTION_TIMEOUT_MS = 5_000;
const S3_REQUEST_TIMEOUT_MS = 25_000;

// 첨부를 쓰는 업무 모듈이 import 한다. 설정이 없어도 기동은 하고 첨부만 503 이다 — 그래서 AppModule 에 넣지 않아도 된다.
@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OptionalStorage => {
        const storage = readOptionalStorageConfig((key) =>
          config.get<string>(key),
        );
        return (
          storage &&
          new StorageService(
            // 요청이 멈추면 끝없이 기다리지 않게 한다. 근로계약 날인본은 쓰기 트랜잭션(60초) 안에서 둘까지 올린다.
            new S3Client({
              region: storage.region,
              requestHandler: {
                connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
                requestTimeout: S3_REQUEST_TIMEOUT_MS,
              },
            }),
            storage.bucket,
          )
        );
      },
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
