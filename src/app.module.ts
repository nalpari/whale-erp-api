import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminSignupModule } from './admin-signup/admin-signup.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BpCodesModule } from './bp-codes/bp-codes.module';
import { BpMastersModule } from './bp-masters/bp-masters.module';
import { BulkExportsModule } from './bulk-exports/bulk-exports.module';
import { CodesModule } from './codes/codes.module';
import { TermsVersionsModule } from './terms-versions/terms-versions.module';
import { AuthModule } from './auth/auth.module';
import { BpAdminsModule } from './bp-admins/bp-admins.module';
import { BpCodeGroupsModule } from './bp-code-groups/bp-code-groups.module';
import { CodeGroupsModule } from './code-groups/code-groups.module';
import { ContractsModule } from './contracts/contracts.module';
import { EnumsModule } from './enums/enums.module';
import { PlatformAdminsModule } from './platform-admins/platform-admins.module';
import { PlatformMenusModule } from './platform-menus/platform-menus.module';
import { PublicHolidaysModule } from './public-holidays/public-holidays.module';
import { BpHolidaysModule } from './bp-holidays/bp-holidays.module';
import { BpRoleGroupsModule } from './bp-role-groups/bp-role-groups.module';
import { PlatformRoleGroupsModule } from './platform-role-groups/platform-role-groups.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationTemplatesModule } from './notification-templates/notification-templates.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { LeadsModule } from './leads/leads.module';
import { PayslipsModule } from './payslips/payslips.module';
import { PostsModule } from './posts/posts.module';
import { PrismaModule } from './prisma/prisma.module';
import { StaffMembersModule } from './staff-members/staff-members.module';
import { StaffSignupModule } from './staff-signup/staff-signup.module';
import { StoresModule } from './stores/stores.module';
import { TodosModule } from './todos/todos.module';
import { WorkSchedulesModule } from './work-schedules/work-schedules.module';
import { AttendanceModule } from './attendance/attendance.module';
import { MyProfileModule } from './my-profile/my-profile.module';
import { HomeModule } from './home/home.module';

@Module({
  imports: [
    // APP_ENV 는 파일이 아니라 실행 환경에서 온다. 파일 안에 두면
    // 어느 파일을 읽을지 정하는 값을 그 파일에서 읽어야 하므로 순환이다.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.APP_ENV ?? 'local'}`,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    AdminSignupModule,
    EnumsModule,
    CodeGroupsModule,
    BpAdminsModule,
    BpCodeGroupsModule,
    PlatformAdminsModule,
    BpRoleGroupsModule,
    PlatformRoleGroupsModule,
    PlatformMenusModule,
    PublicHolidaysModule,
    CodesModule,
    BpCodesModule,
    BpMastersModule,
    TermsVersionsModule,
    // /staff-members/bulk-exports 가 /staff-members/:id 에 먹히지 않게 StaffMembersModule 앞
    BulkExportsModule,
    StaffMembersModule,
    PayslipsModule,
    ContractsModule,
    StoresModule,
    PostsModule,
    NotificationsModule,
    NotificationTemplatesModule,
    LeadsModule,
    InquiriesModule,
    TodosModule,
    WorkSchedulesModule,
    AttendanceModule,
    MyProfileModule,
    StaffSignupModule,
    BpHolidaysModule,
    HomeModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      // main.ts 의 useGlobalPipes 대신 DI 로 등록한다. 그래야 테스트가
      // 만드는 앱에도 같은 파이프가 붙어, e2e 가 운영과 다른 검증을
      // 통과시키는 일이 없다.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true, // DTO 에 없는 필드는 제거
        forbidNonWhitelisted: true, // 모르는 필드가 오면 400
        transform: true, // 페이로드를 DTO 인스턴스로 변환
      }),
    },
  ],
})
export class AppModule {}
