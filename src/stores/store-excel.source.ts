import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { ExcelExportRegistry } from '../excel-exports/excel-export-registry';
import type {
  ExcelExportCaller,
  ExcelExportSource,
} from '../excel-exports/excel-export-source';
import { StoreExcelQueryDto } from './dto/list-stores-query.dto';
import { storeExcelFileName } from './store-excel';
import { StoreManagementService } from './store-management.service';

/** 점포 목록 엑셀(/stores, MN000002). 정책은 공통 엑셀이, 건수 · 파일은 점포 관리가 맡는다. */
@Injectable()
export class StoreExcelSource
  implements ExcelExportSource<StoreExcelQueryDto>, OnModuleInit
{
  readonly menuUrl = '/stores';
  readonly screenName = '점포 목록';
  readonly queryType = StoreExcelQueryDto;

  constructor(
    private readonly management: StoreManagementService,
    private readonly registry: ExcelExportRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  fileName(now: Date): string {
    return storeExcelFileName(now);
  }

  async count(
    caller: ExcelExportCaller,
    query: StoreExcelQueryDto,
  ): Promise<number> {
    return this.management.excelCount(
      caller.adminAccountId,
      bpOf(caller),
      query,
    );
  }

  /** 지금 볼 수 있는 점포 범위의 지문 — 예약 생성 파일을 받을 때 만든 때와 견준다. */
  async scopeKey(caller: ExcelExportCaller): Promise<string> {
    return this.management.excelScopeKey(caller.adminAccountId, bpOf(caller));
  }

  async build(
    caller: ExcelExportCaller,
    query: StoreExcelQueryDto,
  ): Promise<Buffer> {
    return this.management.excelFile(
      caller.adminAccountId,
      bpOf(caller),
      query,
    );
  }
}

/** 점포 화면은 가드가 늘 대상 BP 를 정한다 — 없으면 공통 엑셀에 잘못 넘긴 것이다. */
function bpOf(caller: ExcelExportCaller): TargetBpContext {
  if (!caller.bp) throw new Error('점포 엑셀에 대상 BP 가 없습니다');
  return caller.bp;
}
