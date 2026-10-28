import { ExcelExportRegistry } from '../excel-exports/excel-export-registry';
import { StoreExcelQueryDto } from './dto/list-stores-query.dto';
import { StoreExcelSource } from './store-excel.source';
import type { StoreManagementService } from './store-management.service';

const BP = { bpCodeId: 8, isPlatformCaller: true };

describe('StoreExcelSource', () => {
  const management = {
    excelCount: jest.fn().mockResolvedValue(12),
    excelFile: jest.fn().mockResolvedValue(Buffer.from('PK')),
  };
  const registry = new ExcelExportRegistry();
  const source = new StoreExcelSource(
    management as unknown as StoreManagementService,
    registry,
  );

  it('점포 목록 메뉴(/stores) · 화면 이름 · 한국 날짜 파일 이름', () => {
    expect(source.menuUrl).toBe('/stores');
    expect(source.screenName).toBe('점포 목록');
    expect(source.queryType).toBe(StoreExcelQueryDto);
    expect(source.fileName(new Date('2026-10-27T15:00:00.000Z'))).toBe(
      '점포목록_20261028.xlsx',
    );
  });

  it('기동 때 공통 엑셀에 자기를 등록한다 — 예약 생성 배치가 찾는다', () => {
    source.onModuleInit();
    expect(registry.find('/stores')).toBe(source);
  });

  it('건수 · 파일은 점포 관리의 같은 조건으로 — 대상 BP 를 그대로 넘긴다', async () => {
    const caller = { adminAccountId: 5, bp: BP };
    const query = { statuses: ['CLOSED'] } as never;
    await expect(source.count(caller, query)).resolves.toBe(12);
    await expect(source.build(caller, query)).resolves.toEqual(
      Buffer.from('PK'),
    );
    expect(management.excelCount).toHaveBeenCalledWith(5, BP, query);
    expect(management.excelFile).toHaveBeenCalledWith(5, BP, query);
  });

  it('대상 BP 가 없는 호출자는 설정 잘못이라 던진다 — 점포 화면은 늘 탭 BP 를 정한다', async () => {
    await expect(
      source.count({ adminAccountId: 5, bp: null }, {}),
    ).rejects.toThrow('대상 BP');
  });
});
