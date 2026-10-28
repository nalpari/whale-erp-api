import { Module } from '@nestjs/common';
import { BatchModule } from '../batch/batch.module';
import { HolidayApiModule } from './holiday-api.module';
import { PublicHolidaySyncScheduler } from './public-holiday-sync.scheduler';
import { PublicHolidaySyncService } from './public-holiday-sync.service';
import { PublicHolidaysController } from './public-holidays.controller';
import { PublicHolidaysService } from './public-holidays.service';

@Module({
  imports: [BatchModule, HolidayApiModule],
  controllers: [PublicHolidaysController],
  providers: [
    PublicHolidaysService,
    PublicHolidaySyncService,
    PublicHolidaySyncScheduler,
  ],
})
export class PublicHolidaysModule {}
