import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction } from '../config/profile';
import { readPersonalDataKey } from './personal-data-cipher';

/** 개인정보 암호화 키(Buffer). `PERSONAL_DATA_ENCRYPTION_KEY` 가 비어 있으면 null 이다. */
export const PERSONAL_DATA_KEY = Symbol('PERSONAL_DATA_KEY');

export const personalDataKeyProvider: Provider = {
  provide: PERSONAL_DATA_KEY,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const key = readPersonalDataKey(
      config.get<string>('PERSONAL_DATA_ENCRYPTION_KEY'),
    );
    // 운영에서 비어 있으면 잊은 설정이다. 기동은 막지 않지만(신고 정보 밖의 화면은 써야 한다) 배포 로그에 남긴다.
    if (!key && isProduction())
      new Logger('PersonalDataKey').error(
        'PERSONAL_DATA_ENCRYPTION_KEY 가 비어 있습니다 — 신고 정보 조회 · 저장이 503 입니다',
      );
    return key;
  },
};
