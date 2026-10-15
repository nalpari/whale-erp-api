import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction } from '../config/profile';
import { NtsBusinessClient } from './nts-business.client';

// 국세청 진위확인 클라이언트. 회원가입(AdminSignupModule)과 점포(StoresModule)가 같이 쓴다.
//
// 키(NTS_SERVICE_KEY)는 메일 · 점포 사업자 인증처럼 선택 설정이다(2026-10-15 결정) — 없으면 api 는 뜨고
// 사업자 진위확인만 503 이 된다(가입은 인증 없이 된다). 운영에서 비어 있으면 기동 때 error 로 남겨 배포
// 로그에서 알게 하고, 그 밖에서는 경고만 남긴다. 키가 빠진 배포가 통째로 뜨지 않는 것보다 낫다.
@Module({
  providers: [
    {
      provide: NtsBusinessClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get<string>('NTS_SERVICE_KEY')?.trim();
        if (!key) {
          const message =
            'NTS_SERVICE_KEY 가 없습니다 — 회원가입 · 점포의 사업자 진위확인은 503 입니다';
          const logger = new Logger('NtsModule');
          if (isProduction()) logger.error(message);
          else logger.warn(message);
        }
        return new NtsBusinessClient(key);
      },
    },
  ],
  exports: [NtsBusinessClient],
})
export class NtsModule {}
