import ExcelJS from 'exceljs';
import {
  bizNumberText,
  buildStoreWorkbook,
  maskPhone,
  STORE_EXCEL_COLUMNS,
  type StoreExcelRow,
  storeExcelFileName,
} from './store-excel';

const ROW: StoreExcelRow = {
  storeCode: 'ST000011',
  name: '모리커피 서초점',
  storeTypeCode: 'FRANCHISE',
  storeStatusCode: 'OPERATING',
  bizRegistrationNumber: '1234567890',
  phone: '0212345678',
  address: '서울특별시 서초구 서초대로 1',
  staffCount: 4,
  createdAt: new Date('2026-10-01T15:30:00Z'),
};

async function loadSheet(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook.worksheets[0];
}

async function readBack(buffer: Buffer): Promise<unknown[][]> {
  const sheet = await loadSheet(buffer);
  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    rows.push((row.values as unknown[]).slice(1));
  });
  return rows;
}

describe('maskPhone', () => {
  it.each([
    ['01012345678', '010-****-5678'],
    ['0101234567', '010-***-4567'],
    ['0212345678', '02-****-5678'],
    ['021234567', '02-***-4567'],
    ['0311234567', '031-***-4567'],
    // BP 마스터 연락처도 9~12자리라 050X 평생번호 12자리가 가려질 수 있다.
    ['050720331334', '0507-****-1334'],
  ])('%s → %s', (raw, masked) => {
    expect(maskPhone(raw)).toBe(masked);
  });

  it('비어 있으면 null', () => {
    expect(maskPhone(null)).toBeNull();
  });
});

describe('bizNumberText', () => {
  it('3-2-5 로 끊는다', () => {
    expect(bizNumberText('1234567890')).toBe('123-45-67890');
    expect(bizNumberText(null)).toBeNull();
  });
});

describe('storeExcelFileName', () => {
  it('한국 날짜로 이름을 짓는다', () => {
    expect(storeExcelFileName(new Date('2026-10-14T15:30:00Z'))).toBe(
      '점포목록_20261015.xlsx',
    );
  });
});

describe('buildStoreWorkbook', () => {
  it('열은 화면 [표] 보기와 같은 10개, 같은 순서다', () => {
    expect(STORE_EXCEL_COLUMNS.map((c) => c.header)).toEqual([
      '순번',
      '점포코드',
      '점포명',
      '점포유형',
      '점포상태',
      '사업자등록번호',
      '점포 연락처',
      '점포주소',
      '재직직원',
      '등록일',
    ]);
  });

  it('점포마다 한 줄 — 한글 표기, 주소는 시 · 구까지, 등록일은 한국 날짜만', async () => {
    const rows = await readBack(await buildStoreWorkbook([ROW]));
    expect(rows[0]).toEqual(STORE_EXCEL_COLUMNS.map((c) => c.header));
    const line = Object.fromEntries(
      STORE_EXCEL_COLUMNS.map((c, i) => [c.header, rows[1][i]]),
    );
    expect(line).toEqual({
      순번: 1,
      점포코드: 'ST000011',
      점포명: '모리커피 서초점',
      점포유형: '가맹점포',
      점포상태: '운영',
      사업자등록번호: '123-45-67890',
      '점포 연락처': '02-1234-5678',
      점포주소: '서울특별시 서초구',
      재직직원: 4,
      등록일: '2026-10-02',
    });
  });

  it('순번은 표처럼 전체 건수에서 거꾸로 센다 — 첫 줄이 전체 건수, 마지막 줄이 1', async () => {
    const rows = await readBack(
      await buildStoreWorkbook([
        { ...ROW, storeCode: 'ST000013' },
        { ...ROW, storeCode: 'ST000012' },
        { ...ROW, storeCode: 'ST000011' },
      ]),
    );
    expect(rows.slice(1).map((r) => [r[0], r[1]])).toEqual([
      [3, 'ST000013'],
      [2, 'ST000012'],
      [1, 'ST000011'],
    ]);
  });

  it('050X 평생번호(12자리)는 앞 네 자리로 끊는다', async () => {
    const rows = await readBack(
      await buildStoreWorkbook([{ ...ROW, phone: '050720331334' }]),
    );
    const at = STORE_EXCEL_COLUMNS.findIndex((c) => c.header === '점포 연락처');
    expect(rows[1][at]).toBe('0507-2033-1334');
  });

  it('인증 전이면 사업자등록번호는 「미인증」, 연락처 · 주소가 없으면 「-」', async () => {
    const rows = await readBack(
      await buildStoreWorkbook([
        { ...ROW, bizRegistrationNumber: null, phone: null, address: null },
      ]),
    );
    const line = Object.fromEntries(
      STORE_EXCEL_COLUMNS.map((c, i) => [c.header, rows[1][i]]),
    );
    expect(line['사업자등록번호']).toBe('미인증');
    expect(line['점포 연락처']).toBe('-');
    expect(line['점포주소']).toBe('-');
  });

  it('서식 — 모든 셀 9pt, 머리글은 회색 바탕 · 가운데 정렬 · 굵게, 1행 고정', async () => {
    const sheet = await loadSheet(await buildStoreWorkbook([ROW]));
    const header = sheet.getRow(1);
    header.eachCell((cell) => {
      expect(cell.font).toMatchObject({ bold: true, size: 9 });
      expect(cell.fill).toMatchObject({
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF2F2F2' },
      });
      expect(cell.alignment).toMatchObject({
        horizontal: 'center',
        vertical: 'middle',
      });
    });
    sheet.getRow(2).eachCell((cell) => {
      expect(cell.font).toMatchObject({ size: 9 });
      // 본문은 칠하지 않는다 — 읽어 오면 pattern 'none' 이다
      expect(
        (cell.fill as ExcelJS.FillPattern | undefined)?.pattern ?? 'none',
      ).toBe('none');
    });
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('점포가 없어도 머리글만 있는 파일을 만든다', async () => {
    const rows = await readBack(await buildStoreWorkbook([]));
    expect(rows).toHaveLength(1);
  });

  it('= 로 시작하는 값은 수식이 아니라 글자로 들어간다', async () => {
    const rows = await readBack(
      await buildStoreWorkbook([{ ...ROW, name: '=HYPERLINK("x")' }]),
    );
    const at = STORE_EXCEL_COLUMNS.findIndex((c) => c.header === '점포명');
    expect(rows[1][at]).toBe('=HYPERLINK("x")');
  });
});
