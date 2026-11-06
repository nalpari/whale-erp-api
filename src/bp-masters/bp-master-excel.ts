import ExcelJS from 'exceljs';
import { kstDateTime } from '../common/kst-date-time';
import { styleListSheet } from '../excel-exports/excel-sheet-style';
import { bizNumberText, maskPhone } from '../stores/store-excel';

/**
 * 엑셀 한 줄의 재료 — 목록 화면 표의 칸만(2026-11-06, front 요청). 사업자정보 상세는 담지 않는다. 탈퇴 BP 는 이름 ·
 * 연락처 · 이메일이 null 이다(summaryOf).
 */
export type BpMasterExcelRow = {
  bpCode: string;
  tradeName: string;
  loginId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  accountStatus: string;
  bizRegistrationNumber: string | null;
  joinPath: string;
  createdAt: Date;
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: '사용',
  INACTIVE: '미사용',
  WITHDRAWN: '탈퇴',
};
const JOIN_PATH_LABELS: Record<string, string> = {
  SIGNUP: '회원가입',
  PLATFORM_REGISTERED: '플랫폼등록',
};
/** 탈퇴 BP 의 개인정보 칸 — 화면 표와 같은 문구 */
const WITHDRAWN_TEXT = '탈퇴로 삭제됨';

type Column = {
  header: string;
  width: number;
  value: (row: BpMasterExcelRow) => string | null;
};

/** 탈퇴 BP 는 개인정보 칸을 「탈퇴로 삭제됨」으로 */
const personal =
  (pick: (row: BpMasterExcelRow) => string | null) =>
  (row: BpMasterExcelRow): string | null =>
    row.accountStatus === 'WITHDRAWN' ? WITHDRAWN_TEXT : pick(row);

/**
 * 열 순서 = 파일의 열 순서 = front BP 마스터 목록 표의 열 순서(src/app/bp-masters/bp-master-table.tsx). 연락처는 가운데
 * 자리를 가린다 — 파일은 밖으로 돌기 쉽다.
 */
export const BP_MASTER_EXCEL_COLUMNS: readonly Column[] = [
  { header: 'BP 코드', width: 11, value: (r) => r.bpCode },
  { header: '상호명', width: 20, value: (r) => r.tradeName },
  { header: '아이디', width: 15, value: (r) => r.loginId },
  { header: '이름', width: 12, value: personal((r) => r.name) },
  {
    header: '계정상태',
    width: 9,
    value: (r) => STATUS_LABELS[r.accountStatus] ?? r.accountStatus,
  },
  { header: '연락처', width: 15, value: personal((r) => maskPhone(r.phone)) },
  { header: '이메일', width: 26, value: personal((r) => r.email) },
  {
    header: '사업자등록번호',
    width: 14,
    value: (r) => bizNumberText(r.bizRegistrationNumber),
  },
  {
    header: '가입경로',
    width: 10,
    value: (r) => JOIN_PATH_LABELS[r.joinPath] ?? r.joinPath,
  },
  { header: '등록', width: 17, value: (r) => kstDateTime(r.createdAt) },
];

/** BP 마스터 목록 엑셀(xlsx). 시트 하나, 머리글 한 줄. 예약 생성 파일도 이것으로 만든다. */
export async function buildBpMasterWorkbook(
  rows: BpMasterExcelRow[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('BP 목록', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = BP_MASTER_EXCEL_COLUMNS.map((c) => ({
    header: c.header,
    width: c.width,
  }));
  // 값은 늘 문자열 셀로 넣는다 — '=' 로 시작하는 상호명도 수식이 되지 않는다.
  for (const row of rows)
    sheet.addRow(BP_MASTER_EXCEL_COLUMNS.map((c) => c.value(row)));
  styleListSheet(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** `BP목록_YYYYMMDD.xlsx` — 한국 날짜 */
export function bpMasterExcelFileName(now: Date = new Date()): string {
  return `BP목록_${kstDateTime(now).slice(0, 10).replaceAll('-', '')}.xlsx`;
}
