import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlimtalkService } from './alimtalk.service';
import { BizppurioClient } from './bizppurio.client';
import {
  BIZPPURIO_CONFIG,
  type BizppurioConfig,
  readBizppurioConfig,
} from './bizppurio.config';

// 알림톡을 보내는 모듈이 import 한다. import 되는 순간 BIZPPURIO_* 를 읽어 하나라도 비면 기동을 멈춘다.
// 근로계약 발송(ContractsModule, WHALEERP-136)이 import 하므로 AppModule 이 뜨려면 BIZPPURIO_* 가 있어야 한다(2026-10-16).
// PrismaService 는 전역 PrismaModule 에서 온다.
@Module({
  providers: [
    {
      provide: BIZPPURIO_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readBizppurioConfig((key) => config.get<string>(key)),
    },
    {
      provide: BizppurioClient,
      inject: [BIZPPURIO_CONFIG],
      useFactory: (config: BizppurioConfig) => new BizppurioClient(config),
    },
    AlimtalkService,
  ],
  exports: [AlimtalkService],
})
export class AlimtalkModule {}
