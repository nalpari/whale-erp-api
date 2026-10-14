import { Module } from '@nestjs/common';
import { AdminSessionService } from './admin-session.service';

@Module({
  providers: [AdminSessionService],
  exports: [AdminSessionService],
})
export class AdminSessionModule {}
