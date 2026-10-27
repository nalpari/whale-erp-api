import ExcelJS from 'exceljs';
import {
  addressText,
  bizNumberText,
  kstDateTime,
  maskPhone,
} from '../stores/store-excel';

/** 엑셀 한 줄의 재료 — 목록 항목과 BP 사업자정보. 탈퇴 BP 는 이름 · 연락처 · 이메일이 null 이다. */
export type BpMasterExcelRow = {
  bpCode: string;
  loginId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  accountStatus: string;
  tradeName: string;
  joinPath: string;
  createdAt: Date;
  createdByName: string | null;
  bizRegistrationNumber: string | null;
  bizCeoName: string | null;
  bizCeoPhone: string | null;
  bizCeoEmail: string | null;
  bizOpenDate: string | null;
  bizZipCode: string | null;
  bizAddress: string | null;
  bizAddressDetail: string | null;
  bizCategory: string | null;
  bizItem: string | null;
  bizVerifiedAt: Date | null;
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

type Column = {
  header: string;
  width: number;
  value: (row: BpMasterExcelRow) => string | null;
};

/** 열 순서 = 파일의 열 순서. 목록 항목 다음에 사업자정보다. 연락처 둘은 가운데 자리를 가린다 — 파일은 밖으로 돌기 쉽다. */
export const BP_MASTER_EXCEL_COLUMNS: readonly Column[] = [
  { header: 'BP 코드', width: 12, value: (r) => r.bpCode },
  { header: '아이디', width: 16, value: (r) => r.loginId },
  { header: '이름', width: 12, value: (r) => r.name },
  { header: '연락처', width: 15, value: (r) => maskPhone(r.phone) },
  { header: '이메일', width: 26, value: (r) => r.email },
  {
    header: '상태',
    width: 8,
    value: (r) => STATUS_LABELS[r.accountStatus] ?? r.accountStatus,
  },
  { header: '상호명', width: 20, value: (r) => r.tradeName },
  {
    header: '가입경로',
    width: 11,
    value: (r) => JOIN_PATH_LABELS[r.joinPath] ?? r.joinPath,
  },
  { header: '등록자', width: 12, value: (r) => r.createdByName },
  { header: '등록일시', width: 17, value: (r) => kstDateTime(r.createdAt) },
  {
    header: '사업자 인증',
    width: 11,
    value: (r) => (r.bizVerifiedAt ? '인증완료' : '미인증'),
  },
  {
    header: '사업자등록번호',
    width: 15,
    value: (r) => bizNumberText(r.bizRegistrationNumber),
  },
  { header: '대표자명', width: 12, value: (r) => r.bizCeoName },
  {
    header: '대표자 연락처',
    width: 15,
    value: (r) => maskPhone(r.bizCeoPhone),
  },
  { header: '대표자 이메일', width: 26, value: (r) => r.bizCeoEmail },
  { header: '개업일자', width: 12, value: (r) => r.bizOpenDate },
  {
    header: '사업장 주소',
    width: 40,
    value: (r) => addressText(r.bizZipCode, r.bizAddress, r.bizAddressDetail),
  },
  { header: '업태', width: 14, value: (r) => r.bizCategory },
  { header: '종목', width: 14, value: (r) => r.bizItem },
  {
    header: '최종 인증일시',
    width: 17,
    value: (r) => (r.bizVerifiedAt ? kstDateTime(r.bizVerifiedAt) : null),
  },
];

/** BP 마스터 목록 엑셀(xlsx). 시트 하나, 머리글 한 줄. */
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
  sheet.getRow(1).font = { bold: true };
  // 값은 늘 문자열 셀로 넣는다 — '=' 로 시작하는 상호명도 수식이 되지 않는다.
  for (const row of rows)
    sheet.addRow(BP_MASTER_EXCEL_COLUMNS.map((c) => c.value(row)));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** `BP목록_YYYYMMDD.xlsx` — 한국 날짜 */
export function bpMasterExcelFileName(now: Date = new Date()): string {
  return `BP목록_${kstDateTime(now).slice(0, 10).replaceAll('-', '')}.xlsx`;
}
