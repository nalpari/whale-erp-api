import { Module } from '@nestjs/common';
import { BpHolidayCallerService } from './bp-holiday-caller.service';
import { BpHolidayChangesService } from './bp-holiday-changes.service';
import { BpHolidaysController } from './bp-holidays.controller';
import { BpHolidaysService } from './bp-holidays.service';

@Module({
  controllers: [BpHolidaysController],
  providers: [
    BpHolidayCallerService,
    BpHolidaysService,
    BpHolidayChangesService,
  ],
})
export class BpHolidaysModule {}
