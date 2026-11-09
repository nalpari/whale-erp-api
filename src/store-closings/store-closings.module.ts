import { Module } from '@nestjs/common';
import { StaffMembersModule } from '../staff-members/staff-members.module';
import { StoreClosingsService } from './store-closings.service';

/** 점포 폐점(확인 · 저장) — 점포 관리와 회원 탈퇴가 쓰고, BP 탈퇴가 가져다 쓸 예정이다. 경로는 없다. */
@Module({
  imports: [StaffMembersModule],
  providers: [StoreClosingsService],
  exports: [StoreClosingsService],
})
export class StoreClosingsModule {}
