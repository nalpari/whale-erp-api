import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { FacilitiesController } from './facilities.controller';
import { FacilitiesService } from './facilities.service';
import { FacilityBulkService } from './facility-bulk.service';

@Module({
  imports: [StorageModule],
  controllers: [FacilitiesController],
  providers: [FacilitiesService, FacilityBulkService],
})
export class FacilitiesModule {}
