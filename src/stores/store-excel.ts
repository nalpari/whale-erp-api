import ExcelJS from 'exceljs';
import { kstDateTime } from '../common/kst-date-time';
import { styleListSheet } from '../excel-exports/excel-sheet-style';
import { regionOf, statusLabel, storeTypeLabel } from './store-format';

// 1만 건 기준 · 1분 제한 · xlsx 형식은 공통 엑셀(excel-exports/excel-export-policy · excel-response)에 있다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const NONE = '-';

/** 엑셀 한 줄의 재료 — 목록 화면 [표] 보기의 칸만(2026-11-06, front 요청). 사업자정보는 담지 않는다. */
export type StoreExcelRow = {
  storeCode: string;
  name: string;
  storeTypeCode: string;
  storeStatusCode: string;
  /** 인증 전이면 null — 「미인증」 */
  bizRegistrationNumber: string | null;
  phone: string | null;
  /** 점포주소 칸은 목록의 region(시 · 구)만 쓴다 */
  address: string | null;
  staffCount: number;
  createdAt: Date;
};

/** 한 줄을 그릴 때 함께 넘기는 자리 — 순번을 표처럼 거꾸로 센다 */
type Position = { index: number; total: number };

type Column = {
  header: string;
  width: number;
  value: (row: StoreExcelRow, at: Position) => string | number | null;
};

/** 열 순서 = 파일의 열 순서 = front 점포 목록 [표] 보기의 열 순서(src/app/stores/store-table.tsx). */
export const STORE_EXCEL_COLUMNS: readonly Column[] = [
  // 표처럼 전체 건수에서 거꾸로 센다 — 첫 줄이 전체 건수, 마지막 줄이 1(목록과 같은 정렬)
  { header: '순번', width: 7, value: (_r, at) => at.total - at.index },
  { header: '점포코드', width: 11, value: (r) => r.storeCode },
  { header: '점포명', width: 24, value: (r) => r.name },
  {
    header: '점포유형',
    width: 10,
    value: (r) => storeTypeLabel(r.storeTypeCode),
  },
  {
    header: '점포상태',
    width: 9,
    value: (r) => statusLabel(r.storeStatusCode),
  },
  {
    header: '사업자등록번호',
    width: 14,
    value: (r) => bizNumberText(r.bizRegistrationNumber) ?? '미인증',
  },
  {
    header: '점포 연락처',
    width: 14,
    value: (r) => phoneText(r.phone) ?? NONE,
  },
  { header: '점포주소', width: 20, value: (r) => regionOf(r.address) ?? NONE },
  { header: '재직직원', width: 9, value: (r) => r.staffCount },
  {
    header: '등록일',
    width: 11,
    value: (r) => kstDateTime(r.createdAt).slice(0, 10),
  },
];

/** 점포 목록 엑셀(xlsx). 시트 하나, 머리글 한 줄. 파일에 암호는 걸지 않는다. 예약 생성 파일도 이것으로 만든다. */
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
  // 값은 늘 문자열 · 숫자 셀로 넣는다 — '=' 로 시작하는 점포명도 수식이 되지 않는다.
  rows.forEach((row, index) =>
    sheet.addRow(
      STORE_EXCEL_COLUMNS.map((c) =>
        c.value(row, { index, total: rows.length }),
      ),
    ),
  );
  styleListSheet(sheet);
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
 * 연락처와 관리자 연락처 모두 9~12자리만 받는다.
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
