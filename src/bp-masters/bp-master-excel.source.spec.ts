import { ExcelExportRegistry } from '../excel-exports/excel-export-registry';
import { BpMasterExcelSource } from './bp-master-excel.source';
import type { BpMastersService } from './bp-masters.service';
import { BpMasterFilterDto } from './dto/list-bp-masters.dto';

describe('BpMasterExcelSource', () => {
  const bpMasters = {
    excelCount: jest.fn().mockResolvedValue(7),
    excelFile: jest.fn().mockResolvedValue(Buffer.from('PK')),
    assertExcelCaller: jest.fn().mockResolvedValue(undefined),
  };
  const registry = new ExcelExportRegistry();
  const source = new BpMasterExcelSource(
    bpMasters as unknown as BpMastersService,
    registry,
  );

  it('BP 관리 메뉴(/bp-masters) · 화면 이름 · 한국 날짜 파일 이름', () => {
    expect(source.menuUrl).toBe('/bp-masters');
    expect(source.screenName).toBe('BP 목록');
    expect(source.queryType).toBe(BpMasterFilterDto);
    expect(source.fileName(new Date('2026-10-27T15:00:00.000Z'))).toBe(
      'BP목록_20261028.xlsx',
    );
  });

  it('기동 때 공통 엑셀에 자기를 등록한다', () => {
    source.onModuleInit();
    expect(registry.find('/bp-masters')).toBe(source);
  });

  it('건수 · 파일은 BP 관리의 같은 조건으로 — 플랫폼 화면이라 대상 BP 를 쓰지 않는다', async () => {
    const caller = { adminAccountId: 9, bp: null };
    const query = { statuses: ['ACTIVE'] } as never;
    await expect(source.count(caller, query)).resolves.toBe(7);
    await expect(source.build(caller, query)).resolves.toEqual(
      Buffer.from('PK'),
    );
    expect(bpMasters.excelCount).toHaveBeenCalledWith(query);
    expect(bpMasters.excelFile).toHaveBeenCalledWith(query);
  });

  it('내려받기의 호출자 검사도 플랫폼 계정 판정을 쓴다 — 만든 뒤 플랫폼 권한을 잃으면 받지 못한다', async () => {
    bpMasters.assertExcelCaller.mockRejectedValueOnce(new Error('403'));
    await expect(source.assertRequester(9)).rejects.toThrow('403');
    expect(bpMasters.assertExcelCaller).toHaveBeenCalledWith(9);
  });

  it('파일을 만들기 전에 요청자가 지금도 쓸 수 있는 플랫폼 계정인지 다시 본다 — 예약 생성은 요청 뒤에 만든다', async () => {
    bpMasters.excelFile.mockClear();
    bpMasters.assertExcelCaller.mockRejectedValueOnce(new Error('403'));
    await expect(
      source.build({ adminAccountId: 9, bp: null }, {}),
    ).rejects.toThrow('403');
    expect(bpMasters.assertExcelCaller).toHaveBeenCalledWith(9);
    expect(bpMasters.excelFile).not.toHaveBeenCalled();
  });
});
