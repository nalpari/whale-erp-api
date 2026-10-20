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
    // 비어 있으면 잊은 설정일 수 있다. 기동은 막지 않지만(신고 정보 밖의 화면은 써야 한다) 배포 로그에 남긴다 — 운영은 error,
    // 그 밖은 warn.
    if (!key) {
      const logger = new Logger('PersonalDataKey');
      const message =
        'PERSONAL_DATA_ENCRYPTION_KEY 가 비어 있습니다 — 있는 신고 정보를 읽으면 503 입니다';
      if (isProduction()) logger.error(message);
      else logger.warn(message);
    }
    return key;
  },
};
