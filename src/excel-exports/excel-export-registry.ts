import { Injectable } from '@nestjs/common';
import type { ExcelExportSource } from './excel-export-source';

/**
 * 화면별 엑셀 소스. 각 업무 모듈의 소스가 기동 때(onModuleInit) 자기를 등록하고, 예약 생성 배치가 이력의 메뉴 URL 로
 * 찾아 부른다 — 공통 모듈이 업무 모듈을 import 하지 않게(순환 없이) 거꾸로 등록받는다.
 */
@Injectable()
export class ExcelExportRegistry {
  private readonly sources = new Map<string, ExcelExportSource>();

  register(source: ExcelExportSource): void {
    if (this.sources.has(source.menuUrl))
      throw new Error(`엑셀 소스가 이미 있습니다: ${source.menuUrl}`);
    this.sources.set(source.menuUrl, source);
  }

  find(menuUrl: string): ExcelExportSource | null {
    return this.sources.get(menuUrl) ?? null;
  }

  /** 등록한 화면의 메뉴 URL — 배치는 이 화면들의 예약 생성만 가져간다(만들 소스가 없는 작업을 집지 않게). */
  menuUrls(): string[] {
    return [...this.sources.keys()];
  }
}
