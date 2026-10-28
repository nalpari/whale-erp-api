import { Module } from '@nestjs/common';
import { BatchModule } from '../batch/batch.module';
import { optionalMailServiceProvider } from '../mail/mail.module';
import { StorageModule } from '../storage/storage.module';
import { ExcelDownloadsController } from './excel-downloads.controller';
import { ExcelExportRegistry } from './excel-export-registry';
import { ExcelExportsScheduler } from './excel-exports.scheduler';
import { ExcelExportsService } from './excel-exports.service';

// 모든 화면의 엑셀 공통. 엑셀이 있는 업무 모듈이 import 해 ExcelExportsService.request 로 받고, 자기 소스를
// ExcelExportRegistry 에 등록한다(예약 생성 배치가 찾는다). 메일 · 관리자 웹 주소 · 저장소가 없어도 뜬다 — 그때는 1만 건 이상만 503 이다.
@Module({
  imports: [BatchModule, StorageModule],
  controllers: [ExcelDownloadsController],
  providers: [
    optionalMailServiceProvider,
    ExcelExportRegistry,
    ExcelExportsService,
    ExcelExportsScheduler,
  ],
  exports: [ExcelExportRegistry, ExcelExportsService],
})
export class ExcelExportsModule {}
