import { Module } from '@nestjs/common';
import { API_ENUMS } from './api-enums';
import { DB_ENUMS } from './db-enums.generated';
import { EnumsController } from './enums.controller';
import { EnumsService } from './enums.service';

@Module({
  controllers: [EnumsController],
  providers: [
    {
      provide: EnumsService,
      useFactory: () => new EnumsService(DB_ENUMS, API_ENUMS),
    },
  ],
})
export class EnumsModule {}
