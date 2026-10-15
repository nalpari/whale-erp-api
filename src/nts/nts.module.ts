import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction } from '../config/profile';
import { NtsBusinessClient } from './nts-business.client';

// 국세청 진위확인 클라이언트. 회원가입(AdminSignupModule)과 점포(StoresModule)가 같이 쓴다.
//
// 키(NTS_SERVICE_KEY)는 메일과 다르다 — 없으면 「인증완료」를 줄 수 없어 사업자정보 인증이 늘 실패한다.
// 운영에서는 기동을 멈추고, 개발에서는 기동하되 인증하기가 503 이 된다(기동 때 경고를 남긴다).
@Module({
  providers: [
    {
      provide: NtsBusinessClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const key = config.get<string>('NTS_SERVICE_KEY')?.trim();
        if (!key && isProduction())
          throw new Error('NTS_SERVICE_KEY 가 비어 있다');
        if (!key)
          new Logger('NtsModule').warn(
            'NTS_SERVICE_KEY 가 없습니다 — 회원가입 · 점포의 사업자 진위확인은 503 입니다',
          );
        return new NtsBusinessClient(key);
      },
    },
  ],
  exports: [NtsBusinessClient],
})
export class NtsModule {}
