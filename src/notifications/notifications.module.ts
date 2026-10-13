import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { OpsNotificationService } from './ops-notification.service';

// 업무 모듈이 import 해 OpsNotificationService.notify 를 부른다. 받는 사람은 ./recipients 의 함수로 만든다.
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, OpsNotificationService],
  exports: [OpsNotificationService],
})
export class NotificationsModule {}
