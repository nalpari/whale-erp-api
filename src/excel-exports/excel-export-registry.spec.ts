import { ExcelExportRegistry } from './excel-export-registry';
import type { ExcelExportSource } from './excel-export-source';

const source = (menuUrl: string): ExcelExportSource => ({
  menuUrl,
  screenName: menuUrl,
  queryType: class {},
  fileName: () => 'x.xlsx',
  count: () => Promise.resolve(0),
  build: () => Promise.resolve(Buffer.alloc(0)),
});

describe('ExcelExportRegistry', () => {
  it('메뉴 URL 로 등록한 소스를 찾는다 — 없으면 null', () => {
    const registry = new ExcelExportRegistry();
    const stores = source('/stores');
    registry.register(stores);
    expect(registry.find('/stores')).toBe(stores);
    expect(registry.find('/bp-masters')).toBeNull();
  });

  it('같은 메뉴 URL 을 두 번 등록하면 던진다 — 배치가 어느 쪽을 부를지 모르게 되므로', () => {
    const registry = new ExcelExportRegistry();
    registry.register(source('/stores'));
    expect(() => registry.register(source('/stores'))).toThrow('/stores');
  });
});
