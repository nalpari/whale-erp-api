import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ALIMTALK_TEMPLATE_REGISTRY,
  ALIMTALK_TEMPLATES,
} from './alimtalk-templates';
import { AlimtalkService } from './alimtalk.service';
import { BizppurioClient } from './bizppurio.client';
import {
  BIZPPURIO_CONFIG,
  type BizppurioConfig,
  readBizppurioConfig,
} from './bizppurio.config';

// 알림톡을 보내는 모듈이 import 한다. import 되는 순간 BIZPPURIO_* 를 읽어
// 하나라도 비면 기동을 멈추므로, 쓰는 곳이 없는 지금은 AppModule 에 넣지 않는다.
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
    { provide: ALIMTALK_TEMPLATE_REGISTRY, useValue: ALIMTALK_TEMPLATES },
    AlimtalkService,
  ],
  exports: [AlimtalkService],
})
export class AlimtalkModule {}
