import type { StoreBusinessProfile } from '@prisma/client';
import ExcelJS from 'exceljs';
import { statusLabel, storeTypeLabel } from './store-format';

/** 바로 내려받는 엑셀의 상한. 이 이상은 예약 생성(이메일 링크) 대상이다. */
export const STORE_EXCEL_MAX_ROWS = 10_000;
/** 한 관리자가 엑셀을 다시 받기까지 기다리는 시간. */
export const STORE_EXCEL_INTERVAL_MS = 60_000;
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 엑셀 한 줄의 재료. 목록 항목과 사업자정보다. */
export type StoreExcelRow = {
  storeCode: string;
  name: string;
  storeTypeCode: string;
  storeStatusCode: string;
  bpTradeName: string;
  phone: string | null;
  zipCode: string | null;
  address: string | null;
  addressDetail: string | null;
  staffCount: number;
  createdAt: Date;
  // 칸 이름 · 타입을 Prisma 모델에서 가져온다 — 컬럼이 바뀌면 컴파일러가 알려 준다.
  business: Pick<
    StoreBusinessProfile,
    | 'bizRegistrationNumber'
    | 'bizTradeName'
    | 'bizCeoName'
    | 'bizCeoPhone'
    | 'bizOpenDate'
    | 'bizZipCode'
    | 'bizAddress'
    | 'bizAddressDetail'
    | 'bizCategory'
    | 'bizItem'
  > | null;
};

type Column = {
  header: string;
  width: number;
  value: (row: StoreExcelRow) => string | number | null;
};

/** 열 순서 = 파일의 열 순서. 목록 항목 다음에 사업자정보다. */
export const STORE_EXCEL_COLUMNS: readonly Column[] = [
  { header: '점포코드', width: 12, value: (r) => r.storeCode },
  { header: '점포명', width: 24, value: (r) => r.name },
  {
    header: '점포유형',
    width: 10,
    value: (r) => storeTypeLabel(r.storeTypeCode),
  },
  {
    header: '점포상태',
    width: 10,
    value: (r) => statusLabel(r.storeStatusCode),
  },
  { header: '소속 BP', width: 18, value: (r) => r.bpTradeName },
  { header: '점포 연락처', width: 15, value: (r) => phoneText(r.phone) },
  {
    header: '점포 주소',
    width: 40,
    value: (r) => addressText(r.zipCode, r.address, r.addressDetail),
  },
  { header: '재직직원', width: 11, value: (r) => r.staffCount },
  { header: '등록일시', width: 17, value: (r) => kstDateTime(r.createdAt) },
  {
    header: '사업자 인증',
    width: 11,
    value: (r) => (r.business?.bizRegistrationNumber ? '인증' : '미인증'),
  },
  {
    header: '사업자등록번호',
    width: 15,
    value: (r) => bizNumberText(r.business?.bizRegistrationNumber ?? null),
  },
  {
    header: '상호명',
    width: 20,
    value: (r) => r.business?.bizTradeName ?? null,
  },
  {
    header: '대표자명',
    width: 12,
    value: (r) => r.business?.bizCeoName ?? null,
  },
  // 화면에서는 가리지 않는다. 파일은 밖으로 돌기 쉬워 가운데 자리만 가린다(S-BAYAJS).
  {
    header: '대표자 연락처',
    width: 15,
    value: (r) => maskPhone(r.business?.bizCeoPhone ?? null),
  },
  {
    header: '개업일자',
    width: 12,
    value: (r) => r.business?.bizOpenDate?.toISOString().slice(0, 10) ?? null,
  },
  {
    header: '사업자주소',
    width: 40,
    value: (r) =>
      r.business
        ? addressText(
            r.business.bizZipCode,
            r.business.bizAddress,
            r.business.bizAddressDetail,
          )
        : null,
  },
  { header: '업태', width: 14, value: (r) => r.business?.bizCategory ?? null },
  { header: '종목', width: 14, value: (r) => r.business?.bizItem ?? null },
];

/** 점포 목록 엑셀(xlsx). 시트 하나, 머리글 한 줄. 파일에 암호는 걸지 않는다. */
export async function buildStoreWorkbook(
  rows: StoreExcelRow[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('점포 목록', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = STORE_EXCEL_COLUMNS.map((c) => ({
    header: c.header,
    width: c.width,
  }));
  sheet.getRow(1).font = { bold: true };
  // 값은 늘 문자열 · 숫자 셀로 넣는다 — '=' 로 시작하는 점포명도 수식이 되지 않는다.
  for (const row of rows)
    sheet.addRow(STORE_EXCEL_COLUMNS.map((c) => c.value(row)));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** `점포목록_YYYYMMDD.xlsx` — 한국 날짜 */
export function storeExcelFileName(now: Date = new Date()): string {
  const day = new Date(now.getTime() + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  return `점포목록_${day.replaceAll('-', '')}.xlsx`;
}

/** 사업자등록번호 10자리를 3-2-5 로. */
export function bizNumberText(digits: string | null): string | null {
  if (!digits) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/**
 * 전화번호 숫자를 세 마디로. 02 는 두 자리 지역번호, 12자리는 050X 평생번호라 앞 네 자리다. DB CHECK 가 점포
 * 연락처는 9~12자리, 대표자 연락처는 10~11자리만 받는다.
 */
function phoneParts(digits: string): string[] {
  const head = digits.length === 12 ? 4 : digits.startsWith('02') ? 2 : 3;
  return [digits.slice(0, head), digits.slice(head, -4), digits.slice(-4)];
}

export function phoneText(digits: string | null): string | null {
  return digits ? phoneParts(digits).join('-') : null;
}

/** 가운데 마디를 * 로. */
export function maskPhone(digits: string | null): string | null {
  if (!digits) return null;
  return phoneParts(digits)
    .map((p, i) => (i === 1 ? '*'.repeat(p.length) : p))
    .join('-');
}

export function addressText(
  zipCode: string | null,
  address: string | null,
  addressDetail: string | null,
): string | null {
  const text = [zipCode && `(${zipCode})`, address, addressDetail]
    .filter(Boolean)
    .join(' ');
  return text || null;
}

/** 한국 시각 `YYYY-MM-DD HH:mm` */
export function kstDateTime(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}
