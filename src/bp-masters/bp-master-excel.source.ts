import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ExcelExportRegistry } from '../excel-exports/excel-export-registry';
import type {
  ExcelExportCaller,
  ExcelExportSource,
} from '../excel-exports/excel-export-source';
import { bpMasterExcelFileName } from './bp-master-excel';
import { BpMastersService } from './bp-masters.service';
import { BpMasterFilterDto } from './dto/list-bp-masters.dto';

/** BP 목록 엑셀(/bp-masters, 플랫폼 전용). 정책은 공통 엑셀이, 건수 · 파일은 BP 관리가 맡는다. 대상 BP 를 쓰지 않는다. */
@Injectable()
export class BpMasterExcelSource
  implements ExcelExportSource<BpMasterFilterDto>, OnModuleInit
{
  readonly menuUrl = '/bp-masters';
  readonly screenName = 'BP 목록';
  readonly queryType = BpMasterFilterDto;

  constructor(
    private readonly bpMasters: BpMastersService,
    private readonly registry: ExcelExportRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  fileName(now: Date): string {
    return bpMasterExcelFileName(now);
  }

  count(_caller: ExcelExportCaller, query: BpMasterFilterDto): Promise<number> {
    return this.bpMasters.excelCount(query);
  }

  // 예약 생성은 요청 뒤(배치)에 만든다 — 그 사이 계정이 막히거나 플랫폼 권한을 잃었으면 만들지 않는다.
  async build(
    caller: ExcelExportCaller,
    query: BpMasterFilterDto,
  ): Promise<Buffer> {
    await this.bpMasters.assertExcelCaller(caller.adminAccountId);
    return this.bpMasters.excelFile(query);
  }
}
