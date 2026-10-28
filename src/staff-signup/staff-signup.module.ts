import { Module } from '@nestjs/common';
import { AuthSessionModule } from '../auth-session/auth-session.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AffiliationRequestsService } from './affiliation-requests.service';
import { MyAffiliationRequestsController } from './my-affiliation-requests.controller';
import { MyInvitationsController } from './my-invitations.controller';
import { StaffSignupController } from './staff-signup.controller';
import { StaffSignupService } from './staff-signup.service';

// 요청 제한 · 로그인 응답은 AuthModule, 접속 상태는 AuthSessionModule, 만 19세 미만 · 소속 추가 확인 거절 운영 알림은
// NotificationsModule 의 것을 쓴다.
@Module({
  imports: [AuthModule, AuthSessionModule, NotificationsModule],
  controllers: [
    StaffSignupController,
    MyInvitationsController,
    MyAffiliationRequestsController,
  ],
  providers: [StaffSignupService, AffiliationRequestsService],
})
export class StaffSignupModule {}
