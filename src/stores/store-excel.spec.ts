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
  bpTradeName: '모리커피',
  phone: '0212345678',
  zipCode: '06611',
  address: '서울특별시 서초구 서초대로 1',
  addressDetail: '1층',
  staffCount: 4,
  createdAt: new Date('2026-10-01T15:30:00Z'),
  business: {
    bizRegistrationNumber: '1234567890',
    bizTradeName: '모리커피 서초',
    bizCeoName: '김대표',
    bizCeoPhone: '01012345678',
    bizOpenDate: new Date('2020-03-02T00:00:00Z'),
    bizZipCode: '06611',
    bizAddress: '서울특별시 서초구 서초대로 1',
    bizAddressDetail: '2층',
    bizCategory: '음식점업',
    bizItem: '커피',
  },
};

async function readBack(buffer: Buffer): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
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
    ['15881234', '1588-****'],
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
  it('머리글 한 줄 뒤에 점포마다 한 줄 — 한글 표기, 한국 시각, 대표자 연락처만 가린다', async () => {
    const rows = await readBack(await buildStoreWorkbook([ROW]));
    expect(rows[0]).toEqual(STORE_EXCEL_COLUMNS.map((c) => c.header));
    const line = Object.fromEntries(
      STORE_EXCEL_COLUMNS.map((c, i) => [c.header, rows[1][i]]),
    );
    expect(line).toEqual({
      점포코드: 'ST000011',
      점포명: '모리커피 서초점',
      점포유형: '가맹점포',
      점포상태: '운영',
      '소속 BP': '모리커피',
      '점포 연락처': '02-1234-5678',
      '점포 주소': '(06611) 서울특별시 서초구 서초대로 1 1층',
      '근무직원 수': 4,
      등록일시: '2026-10-02 00:30',
      '사업자 인증': '인증',
      사업자등록번호: '123-45-67890',
      상호명: '모리커피 서초',
      대표자명: '김대표',
      '대표자 연락처': '010-****-5678',
      개업일자: '2020-03-02',
      사업자주소: '(06611) 서울특별시 서초구 서초대로 1 2층',
      업태: '음식점업',
      종목: '커피',
    });
  });

  it('사업자정보가 없으면 미인증이고 칸은 빈다', async () => {
    const rows = await readBack(
      await buildStoreWorkbook([
        {
          ...ROW,
          phone: null,
          address: null,
          zipCode: null,
          addressDetail: null,
          business: null,
        },
      ]),
    );
    const line = Object.fromEntries(
      STORE_EXCEL_COLUMNS.map((c, i) => [c.header, rows[1][i]]),
    );
    expect(line['사업자 인증']).toBe('미인증');
    expect(line['사업자등록번호']).toBeUndefined();
    expect(line['대표자 연락처']).toBeUndefined();
    expect(line['점포 연락처']).toBeUndefined();
    expect(line['점포 주소']).toBeUndefined();
  });

  it('점포가 없어도 머리글만 있는 파일을 만든다', async () => {
    const rows = await readBack(await buildStoreWorkbook([]));
    expect(rows).toHaveLength(1);
  });

  it('= 로 시작하는 값은 수식이 아니라 글자로 들어간다', async () => {
    const rows = await readBack(
      await buildStoreWorkbook([{ ...ROW, name: '=HYPERLINK("x")' }]),
    );
    expect(rows[1][1]).toBe('=HYPERLINK("x")');
  });
});
