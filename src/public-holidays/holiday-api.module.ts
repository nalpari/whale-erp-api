import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction } from '../config/profile';
import { HolidayApiClient } from './holiday-api.client';

// 공휴일 API(한국천문연구원 특일 정보) 클라이언트. 공식 휴일 동기화 배치가 쓴다.
//
// 키(HOLIDAY_SERVICE_KEY)는 국세청 키처럼 선택 설정이다 — 없으면 api 는 뜨고 동기화만 실패 이력을 남긴다. 운영에서
// 비어 있으면 기동 때 error 로 남겨 배포 로그에서 알게 하고, 그 밖에서는 경고만 남긴다.
@Module({
  providers: [
    {
      provide: HolidayApiClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get<string>('HOLIDAY_SERVICE_KEY')?.trim();
        if (!key) {
          const message =
            'HOLIDAY_SERVICE_KEY 가 없습니다 — 공식 휴일 동기화 배치는 실패 이력만 남깁니다';
          const logger = new Logger('HolidayApiModule');
          if (isProduction()) logger.error(message);
          else logger.warn(message);
        }
        return new HolidayApiClient(key || undefined);
      },
    },
  ],
  exports: [HolidayApiClient],
})
export class HolidayApiModule {}
