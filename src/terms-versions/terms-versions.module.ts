import { Module } from '@nestjs/common';
import { CodesModule } from '../codes/codes.module';
import { TermsVersionsController } from './terms-versions.controller';
import { TermsVersionsService } from './terms-versions.service';

@Module({
  imports: [CodesModule],
  controllers: [TermsVersionsController],
  providers: [TermsVersionsService],
})
export class TermsVersionsModule {}
