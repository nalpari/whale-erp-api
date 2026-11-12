import { inflateRawSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { NO_NUL } from '../common/no-nul';
import {
  EXCEL_FONT_NAME,
  EXCEL_FONT_SIZE,
  EXCEL_HEADER_FILL,
} from '../excel-exports/excel-sheet-style';
import { parseDateOnly } from '../staff-members/kst-date';
import {
  BULK_BUSY,
  BULK_BUSY_CODE,
  BULK_NOT_TEMPLATE,
  BULK_TOO_COMPLEX,
  BULK_UNREADABLE,
  readSheetInWorker,
  type WorkerCellValue,
  writeErrorColumnInWorker,
} from './facility-bulk-reader';
import {
  type FacilityGroup,
  QUANTITY_MAX,
  totalAmountOf,
  UNIT_PRICE_MAX,
} from './facility-format';

// 시설물·장비 엑셀 일괄 등록(정책서 PL-7)의 파일 쪽 — 양식 만들기 · 올린 파일 읽기 · 줄 검사 · 오류 파일. DB 를 모른다.
// 서버는 파일을 남기지 않는다 — 미리보기 · 오류 파일 · 등록마다 화면이 같은 파일을 다시 보낸다(일괄 등록 공통 API 요청, 2026-11-12).
// 줄 검사는 POST /facilities(SaveFacilityDto · validated)와 같은 규칙이고, 문구만 「칸 이름: 사유」 모양이다.

/** 한 번에 올릴 수 있는 줄 수(PL-7 제안 500) */
export const BULK_MAX_ROWS = 500;
/** 올리는 파일의 크기 상한 — 500줄 양식은 1MB 안이다. 화면(front bulk-upload.ts)과 같은 5MB */
export const BULK_MAX_BYTES = 5 * 1024 * 1024;
/**
 * 압축을 푼 크기의 상한 — 이 스레드가 zip 사전 검사로 푸는 양을 막는다. exceljs 가 읽으며 쓰는 메모리는 worker 의 상한이
 * 막는다(facility-bulk-reader). 500줄을 꽉 채운 첫 시트는 약 1MB 이고, 「점포 목록」 시트가 점포 수에 비례해 커져 열린 점포
 * 1만 곳이면 약 3.5MB 다 — 수만 곳의 BP 도 받은 양식을 그대로 올릴 수 있게 16MB.
 */
export const BULK_MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
/** zip 항목 수 상한 — 양식은 항목 십여 개다 */
const MAX_ZIP_ENTRIES = 1000;
/**
 * eachRow 가 방문하는 행 수 상한(머리글 제외) — 공백만 있는 줄은 500줄에 세지 않지만 방문하면 24칸 셀을 만든다(6만 줄에
 * heap 321MB, PR #276 리뷰). 500줄 + 여유분을 넘으면 칸을 만들기 전에 줄 수 초과로 막는다.
 */
const MAX_VISITED_ROWS = BULK_MAX_ROWS * 2;
/**
 * worker 가 메인으로 보내는 칸 하나의 글자 수 상한 — 가장 긴 칸(메모 · 점검 비고 200자)의 다섯 배. 넘으면 내용 대신 표시만
 * 온다. 같은 공유 문자열을 여러 칸이 가리키면 메인에선 칸마다 복사본이 생기기 때문이다(PR #276 3차 리뷰).
 */
const MAX_CELL_TEXT = 1_000;
/** worker 가 보내는 글자 전체의 상한 — 500줄을 칸마다 최대 길이로 채워도 약 75만 자다 */
const MAX_TOTAL_TEXT = 4_000_000;

export const BULK_TEMPLATE_ONLY = BULK_NOT_TEMPLATE;
export { BULK_BUSY, BULK_BUSY_CODE, BULK_TOO_COMPLEX, BULK_UNREADABLE };
export const BULK_TOO_MANY = `한 번에 ${BULK_MAX_ROWS}건까지 등록할 수 있습니다. 파일을 나눠 올려 주세요.`;
export const BULK_TOO_LARGE =
  '파일 내용이 너무 큽니다. 그림 · 다른 시트 없이 내려받은 양식에 값만 적어 다시 올려 주세요.';
export const BULK_EMPTY = '등록할 시설물·장비가 없습니다.';
export const BULK_HAS_ERRORS = '오류를 고친 파일을 다시 올려 주세요.';
export const BULK_STORE_CHANGED =
  '미리보기 뒤 폐점되거나 삭제된 점포가 있습니다. 파일을 다시 올려 미리보기를 확인해 주세요.';
export const BULK_NO_ERRORS = '오류가 있는 줄이 없습니다.';
export const BULK_CELL_TOO_LONG = `글자가 너무 깁니다(${MAX_CELL_TEXT.toLocaleString('ko-KR')}자 초과). 값을 줄여 다시 적어 주세요.`;

export const BULK_TEMPLATE_FILE_NAME = '시설물장비_일괄등록_양식.xlsx';
/** 오류 파일 이름 — 「올린파일이름_오류.xlsx」(확장자는 대소문자 없이 뗀다, 이름이 없으면 기본 이름) */
export const bulkErrorFileName = (fileName: string) =>
  `${fileName.trim().replace(/\.xlsx$/i, '') || '시설물장비_일괄등록'}_오류.xlsx`;

const SHEET_NAME = '시설물·장비';
const STORE_SHEET_NAME = '점포 목록';
const CHOICE_SHEET_NAME = '선택값';
const ERROR_HEADER = '오류 사유';
/** 드롭다운 · 글자 서식을 거는 마지막 행 — 머리글 + 500줄 */
const LAST_ROW = BULK_MAX_ROWS + 1;

/**
 * 양식 칸 — 순서가 곧 열 순서다. label 은 머리글(필수는 *), name 은 오류 문구의 칸 이름. 정책서 PL-7 의 24칸이고, 첫 칸만
 * 「점포코드」가 아니라 「점포」다 — 드롭다운 값이 「점포명 [점포코드]」라서(2026-11-12 사용자 결정).
 */
export const BULK_HEADERS = [
  { key: 'store', label: '점포*', name: '점포' },
  { key: 'name', label: '시설물/장비명*', name: '시설물/장비명' },
  { key: 'status', label: '운영상태*', name: '운영상태' },
  { key: 'group', label: '그룹*', name: '그룹' },
  { key: 'category', label: '분류*', name: '분류' },
  { key: 'brand', label: '브랜드', name: '브랜드' },
  { key: 'manufacturer', label: '제조사', name: '제조사' },
  { key: 'serialNumber', label: 'Serial number', name: 'Serial number' },
  { key: 'installationLocation', label: '설치 위치', name: '설치 위치' },
  { key: 'vendorName', label: '구매처', name: '구매처' },
  { key: 'vendorPhone', label: '구매처 전화번호', name: '구매처 전화번호' },
  { key: 'salesRepresentativeName', label: '영업사원', name: '영업사원' },
  {
    key: 'salesRepresentativePhone',
    label: '영업사원 전화번호',
    name: '영업사원 전화번호',
  },
  { key: 'unitPrice', label: '단가', name: '단가' },
  { key: 'quantity', label: '수량', name: '수량' },
  { key: 'vatIncluded', label: '부가세 포함(Y/N)', name: '부가세 포함' },
  { key: 'purchaseDate', label: '구매일', name: '구매일' },
  { key: 'installationDate', label: '설치일', name: '설치일' },
  { key: 'memo', label: '메모', name: '메모' },
  { key: 'usageExpiryDate', label: '사용 유효기한', name: '사용 유효기한' },
  { key: 'warrantyExpiryDate', label: '품질 보증기한', name: '품질 보증기한' },
  { key: 'inspectionCycle', label: '점검 주기', name: '점검 주기' },
  { key: 'inspectionNote', label: '점검 비고', name: '점검 비고' },
  {
    key: 'serviceCenterPhone',
    label: 'A/S센터 전화번호',
    name: 'A/S센터 전화번호',
  },
] as const;

export type BulkField = (typeof BULK_HEADERS)[number]['key'];
const COLUMN_OF = Object.fromEntries(
  BULK_HEADERS.map((h, i) => [h.key, i + 1]),
) as Record<BulkField, number>;
const NAME_OF = Object.fromEntries(
  BULK_HEADERS.map((h) => [h.key, h.name]),
) as Record<BulkField, string>;

const PHONE_FIELDS: ReadonlySet<BulkField> = new Set<BulkField>([
  'vendorPhone',
  'salesRepresentativePhone',
  'serviceCenterPhone',
]);
/** 숫자로 들어오면 값이 바뀌었을 수 있는 식별자 칸 — 큰 수는 정밀도를 잃고 지수 표기가 된다 */
const IDENTIFIER_FIELDS: ReadonlySet<BulkField> = new Set<BulkField>([
  'serialNumber',
]);

/** 미리보기 표의 열(PL-7, 데모 facility-bulk.mjs) — 응답 columns 그대로 */
export const BULK_PREVIEW_COLUMNS = [
  { key: 'storeName', label: '점포' },
  { key: 'group', label: '그룹' },
  { key: 'category', label: '분류' },
  { key: 'name', label: '시설물/장비명' },
  { key: 'purchaseDate', label: '구매일' },
  { key: 'installationDate', label: '설치일' },
] as const;
export type BulkPreviewKey = (typeof BULK_PREVIEW_COLUMNS)[number]['key'];

/**
 * 올린 파일의 한 줄 — 엑셀 행 번호(2 이상)와 칸마다 글자(빈 칸은 ''). problems 는 읽을 수 없던 칸(오류 값 · 결과 없는 수식 ·
 * 값이 바뀐 숫자)과 그 사유 — 그 칸은 비어 있는 것으로 두지 않고 줄 오류가 된다.
 */
export interface BulkRawRow {
  readonly rowNumber: number;
  readonly cells: Readonly<Record<BulkField, string>>;
  readonly problems?: Readonly<Partial<Record<BulkField, string>>>;
}

export interface BulkCode {
  code: string;
  label: string;
}

/** 범위 안 점포 한 곳 */
export interface BulkStore {
  storeId: number;
  storeCode: string;
  name: string;
  isClosed: boolean;
}

/** 줄 검사에 쓰는 값 — 서비스가 DB 에서 읽어 준다 */
export interface BulkLookups {
  /** 관리 점포 범위 안의 지우지 않은 점포(폐점 포함 — 「폐점」과 「범위 밖」을 가른다). 키는 점포코드 */
  stores: ReadonlyMap<string, BulkStore>;
  /** 운영상태 — 플랫폼 원본의 사용 중인 코드 */
  statuses: readonly BulkCode[];
  /** 그룹 — 사용 중인 공통코드 그룹과 그 이름 */
  groups: readonly { code: FacilityGroup; label: string }[];
  /** 분류 — 그룹마다 그 BP 의 사용 중인 상세 코드 */
  categories: Record<FacilityGroup, readonly BulkCode[]>;
  /** 점검 주기 — 그 BP 의 사용 중인 상세 코드 */
  cycles: readonly BulkCode[];
}

/** 한 줄을 저장할 값 — facilities 행의 칸(관리 담당자 · A/S센터 주소 · 문서는 양식에 없다) */
export interface BulkFacilityData {
  storeId: number;
  name: string;
  facilityStatusCode: string;
  facilityGroupCode: FacilityGroup;
  facilityCategoryCode: string;
  memo: string | null;
  brand: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  installationLocation: string | null;
  vendorName: string | null;
  vendorPhone: string | null;
  salesRepresentativeName: string | null;
  salesRepresentativePhone: string | null;
  unitPriceAmount: number | null;
  quantity: number;
  totalAmount: number | null;
  isVatIncluded: boolean;
  purchaseDate: Date | null;
  installationDate: Date | null;
  usageExpiryDate: Date | null;
  warrantyExpiryDate: Date | null;
  inspectionCycleCode: string | null;
  inspectionNote: string | null;
  serviceCenterPhone: string | null;
}

/**
 * 줄 검사 결과 — 정상이면 저장할 값이 있고 사유가 없다, 오류면 사유가 있고 저장할 값이 없다. 미리보기(isValid)와 등록이
 * 같은 판별자를 본다.
 */
export type BulkCheckedRow =
  | {
      isValid: true;
      /** 미리보기에 보일 글자(코드가 아니라 한글 · 점포명) */
      values: Record<BulkPreviewKey, string>;
      errors: [];
      data: BulkFacilityData;
    }
  | {
      isValid: false;
      values: Record<BulkPreviewKey, string>;
      /** 「칸 이름: 사유」 — 칸 순서 */
      errors: string[];
      data: null;
    };

const isDate = (value: unknown): value is Date =>
  Object.prototype.toString.call(value) === '[object Date]';

/** 셀을 읽은 결과 — 글자와, 읽을 수 없었으면 그 사유 */
interface CellRead {
  text: string;
  problem?: string;
}

/** 셀 값 — worker 가 단순하게 바꿔 보낸 꼴(WorkerCellValue)이거나 exceljs 값 그대로 */
type AnyCellValue = ExcelJS.CellValue | WorkerCellValue | undefined;

/**
 * 셀 값을 읽는다 — 엑셀은 숫자 · 날짜 · 서식 있는 글자 · 수식으로 줄 수 있다. 날짜는 YYYY-MM-DD(exceljs 는 엑셀 날짜를
 * UTC 자정으로 준다), 수식은 계산 결과. 오류 값(#N/A 등) · 저장된 결과가 없는 수식(엑셀이 아닌 도구로 만든 파일) · 모르는
 * 셀 모양 · worker 가 길이 상한으로 내용을 뺀 칸은 빈 칸이 아니라 사유를 돌려준다 — 빈 칸으로 두면 선택 칸의 값이 말없이
 * 사라진다.
 */
function readCell(input: AnyCellValue): CellRead {
  const value = input as ExcelJS.CellValue | undefined;
  if (value === null || value === undefined) return { text: '' };
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'number') return { text: String(value) };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
  // worker 가 넘긴 날짜는 다른 realm 의 Date 라 instanceof 가 맞지 않을 수 있다(테스트 vm) — 태그로 본다
  if (isDate(value))
    return Number.isNaN(value.getTime())
      ? {
          text: '',
          problem: '날짜를 읽지 못했습니다. YYYY-MM-DD 로 적어 주세요.',
        }
      : { text: value.toISOString().slice(0, 10) };
  if ('tooLong' in value) return { text: '', problem: BULK_CELL_TOO_LONG };
  if ('richText' in value)
    return { text: value.richText.map((r) => r.text).join('') };
  if ('error' in value)
    return {
      text: '',
      problem: `셀 값이 오류(${String(value.error)})입니다. 값을 직접 적어 주세요.`,
    };
  if ('formula' in value || 'sharedFormula' in value) {
    const result = (value as { result?: ExcelJS.CellValue }).result;
    if (result === undefined)
      return {
        text: '',
        problem: '수식의 결과가 저장되지 않았습니다. 값으로 붙여 넣어 주세요.',
      };
    return readCell(result);
  }
  if ('text' in value) return readCell(value.text);
  return {
    text: '',
    problem: '읽을 수 없는 셀 값입니다. 값을 직접 적어 주세요.',
  };
}

/** 셀 값을 글자로 — 읽을 수 없는 셀은 '' (머리글 검사 등 사유가 필요 없는 곳) */
export function cellText(value: AnyCellValue): string {
  return readCell(value).text;
}

/** 수식이면 계산 결과, 아니면 그 값 */
function resultOf(value: AnyCellValue): AnyCellValue {
  return value !== null &&
    typeof value === 'object' &&
    ('formula' in value || 'sharedFormula' in value)
    ? (value as { result?: AnyCellValue }).result
    : value;
}

/**
 * 엑셀이 숫자로 바꿔 앞 0 을 지운 전화번호를 되살린다(수식 결과도) — 국내 번호(9~12자리)는 모두 0 으로 시작한다. 0 을
 * 붙여 그 꼴이 될 때만 붙인다: 0 을 뺀 9~11자리, 또는 8자리면 서울(2로 시작) 번호. 대표번호(15881234 같은 8자리)에
 * 붙이면 틀린 9자리 번호가 통과하므로 그대로 둬 길이 검사에 걸리게 한다.
 */
function readPhone(value: AnyCellValue): CellRead {
  const v = resultOf(value);
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
    const d = String(v);
    if (
      d.length <= 11 &&
      (d.length >= 9 || (d.length === 8 && d.startsWith('2')))
    )
      return { text: `0${d}` };
  }
  return readCell(value);
}

/**
 * 식별자 칸 — 숫자로 들어와 정밀도를 잃었을 수 있거나 지수 표기가 된 값은 사유로 돌려준다.
 * Excel 은 숫자를 유효숫자 15자리까지만 저장하므로 경계는 2^53 이 아니라 16자리(1e15)다.
 */
function readIdentifier(value: AnyCellValue): CellRead {
  const v = resultOf(value);
  if (typeof v === 'number' && (Math.abs(v) >= 1e15 || /e/i.test(String(v))))
    return {
      text: '',
      problem:
        '숫자로 저장돼 값이 바뀌었을 수 있습니다. 셀 서식을 텍스트로 바꿔 다시 적어 주세요.',
    };
  return readCell(value);
}

/** xlsx(zip) 서명 — 확장자는 믿지 않는다 */
const isZip = (buffer: Buffer) =>
  buffer.length >= 4 &&
  buffer[0] === 0x50 &&
  buffer[1] === 0x4b &&
  buffer[2] === 0x03 &&
  buffer[3] === 0x04;

/**
 * zip 을 읽기 전에 실제로 풀리는 양을 센다.
 * - 중앙 디렉터리에 적힌 압축 해제 크기는 보낸 쪽이 적는 값이라 믿지 않고, 항목마다 maxOutputLength 를 걸고 풀어 본다
 *   (남은 한도까지만 푼다). 넘으면 400(내용 과대 문구).
 * - 중앙 디렉터리가 끝 레코드 바로 앞에 꼭 맞게 있어야 한다(위치 + 크기 = 끝 레코드, 다 돈 뒤 끝 레코드에 닿음). exceljs 가
 *   쓰는 JSZip 은 앞에 덧붙은 바이트만큼 모든 위치를 옮겨 읽으므로, 그 틈을 두면 여기서 센 목록과 실제로 풀리는 목록이
 *   달라진다(2026-11-12 리뷰).
 * - 로컬 항목이 서로 겹치면(같은 위치를 여러 항목이 가리키는 것 포함) 400(양식 문구) — 메인 스레드가 푸는 입력의 합을
 *   파일 크기 안으로 묶는다(PR #276 7차 리뷰).
 * - zip 이 아니거나 깨졌거나 zip64 · 항목이 너무 많거나 저장(0) · deflate(8) 밖의 압축 방식이면 400(양식 문구).
 *   zlib 의 데이터 오류(Z_*)만 깨진 파일로 보고, 그 밖의 예외(메모리 등)는 그대로 던진다(500 — 우리 쪽 문제).
 */
export function assertZipWithinLimit(buffer: Buffer, maxBytes: number): void {
  const broken = () => new BadRequestException(BULK_TEMPLATE_ONLY);
  const tooBig = () => new BadRequestException(BULK_TOO_LARGE);
  if (!isZip(buffer) || buffer.length < 22) throw broken();
  // 중앙 디렉터리 끝 레코드 — 22바이트 + 주석(최대 65535)
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw broken();
  const entries = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const directory = buffer.readUInt32LE(eocd + 16);
  if (
    entries === 0xffff ||
    size === 0xffffffff ||
    directory === 0xffffffff ||
    entries > MAX_ZIP_ENTRIES ||
    directory + size !== eocd
  )
    throw broken();
  let p = directory;
  const items: {
    method: number;
    local: number;
    start: number;
    compressed: number;
  }[] = [];
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || buffer.readUInt32LE(p) !== 0x02014b50) throw broken();
    const method = buffer.readUInt16LE(p + 10);
    const compressed = buffer.readUInt32LE(p + 20);
    const local = buffer.readUInt32LE(p + 42);
    p +=
      46 +
      buffer.readUInt16LE(p + 28) +
      buffer.readUInt16LE(p + 30) +
      buffer.readUInt16LE(p + 32);
    if (local + 30 > directory || buffer.readUInt32LE(local) !== 0x04034b50)
      throw broken();
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    if (start + compressed > directory) throw broken();
    items.push({ method, local, start, compressed });
  }
  if (p !== eocd) throw broken();
  // 로컬 항목은 서로 겹치지 않아야 한다(각 항목은 앞 항목의 데이터 끝 뒤에서 시작). 그래야 아래에서 푸는 입력의 합이
  // 파일 크기를 넘지 않는다 — 출력만 세면, 출력이 0바이트인 빈 deflate 블록 5MB 를 항목 1,000개가 같은 위치로 가리킨
  // 파일 하나에 메인 스레드가 같은 입력을 1,000번 풀어 이벤트 루프가 33초 멈췄다(PR #276 7차 리뷰). 중앙 디렉터리 순서는
  // 로컬 순서와 다를 수 있어 위치로 정렬해 본다.
  const ordered = [...items].sort((a, b) => a.local - b.local);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    if (ordered[i].local < prev.start + prev.compressed) throw broken();
  }
  let total = 0;
  for (const { method, start, compressed } of items) {
    let content: Buffer;
    if (method === 0) content = buffer.subarray(start, start + compressed);
    else if (method === 8) {
      try {
        content = inflateRawSync(buffer.subarray(start, start + compressed), {
          maxOutputLength: maxBytes - total + 1,
        });
      } catch (error) {
        // 코드로 본다 — 테스트 실행 환경(vm)에선 Node 오류에 instanceof 가 맞지 않는다
        const code = (error as { code?: unknown }).code;
        if (code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
        if (typeof code === 'string' && code.startsWith('Z_')) throw broken();
        throw error;
      }
    } else throw broken();
    total += content.length;
    if (total > maxBytes) throw tooBig();
  }
}

/** 올린 파일을 읽은 결과 — 줄들과, 오류 파일을 만들 때 다시 쓸 원본(검사를 마친 같은 파일) */
export interface ParsedBulkFile {
  readonly rows: readonly BulkRawRow[];
  readonly source: Buffer;
}

/** 머리글이 양식과 같은가 — 끝의 「오류 사유」 열(오류 파일을 고쳐 다시 올린 것)은 받는다 */
function headerMatches(header: readonly AnyCellValue[]): boolean {
  if (!BULK_HEADERS.every((h, i) => cellText(header[i]).trim() === h.label))
    return false;
  const extra = cellText(header[BULK_HEADERS.length]).trim();
  return extra === '' || extra === ERROR_HEADER;
}

/**
 * 올린 파일을 읽는다 — 양식이 아니면 · 내용이 없으면 · 500줄을 넘으면 400. 칸이 모두 빈 글자이거나 공백뿐인 줄은 세지
 * 않는다(서식 · 드롭다운만 있는 행은 eachRow 가 애초에 건너뛴다). 행 번호는 엑셀 그대로다.
 * - exceljs 로 여는 일은 메모리 · 시간 상한이 걸린 worker 에서만 한다(facility-bulk-reader) — 이 프로세스는 상한 안의 셀
 *   값만 받는다(칸 1,000자 · 전체 400만 자). 그 전에 압축 해제 양(assertZipWithinLimit)만 본다 — 이 스레드가 푸는 양을
 *   묶으려는 것이다. XML 을 이 스레드에서 정규식으로 훑지 않는다 — 우회되고, 이차 시간이라 그 자체로 이벤트 루프를 멈췄다.
 * - 실제 있는 행만 돈다(eachRow) — rowCount 는 마지막으로 쓰인 행 번호라 먼 셀 하나로 100만이 된다. 공백뿐인 줄도 방문
 *   수에 세어 1,000행을 넘으면 칸을 만들기 전에 멈춘다.
 */
export async function readBulkFile(
  buffer: Buffer,
  { maxUncompressedBytes = BULK_MAX_UNCOMPRESSED_BYTES } = {},
): Promise<ParsedBulkFile> {
  assertZipWithinLimit(buffer, maxUncompressedBytes);
  const sheet = await readSheetInWorker(buffer, {
    columns: BULK_HEADERS.length,
    maxVisitedRows: MAX_VISITED_ROWS,
    maxCellText: MAX_CELL_TEXT,
    maxTotalText: MAX_TOTAL_TEXT,
  });
  if (sheet.tooLarge) throw new BadRequestException(BULK_TOO_LARGE);
  if (!headerMatches(sheet.header))
    throw new BadRequestException(BULK_TEMPLATE_ONLY);
  if (sheet.overflow) throw new BadRequestException(BULK_TOO_MANY);
  const rows: BulkRawRow[] = [];
  for (const { rowNumber, values } of sheet.rows) {
    const cells = {} as Record<BulkField, string>;
    const problems: Partial<Record<BulkField, string>> = {};
    BULK_HEADERS.forEach((h, i) => {
      const value = values[i];
      const read = PHONE_FIELDS.has(h.key)
        ? readPhone(value)
        : IDENTIFIER_FIELDS.has(h.key)
          ? readIdentifier(value)
          : readCell(value);
      cells[h.key] = read.text;
      if (read.problem) problems[h.key] = read.problem;
    });
    const hasProblems = Object.keys(problems).length > 0;
    if (!hasProblems && Object.values(cells).every((v) => v.trim() === ''))
      continue;
    if (rows.length === BULK_MAX_ROWS)
      throw new BadRequestException(BULK_TOO_MANY);
    rows.push(
      hasProblems ? { rowNumber, cells, problems } : { rowNumber, cells },
    );
  }
  if (rows.length === 0) throw new BadRequestException(BULK_EMPTY);
  return { rows, source: buffer };
}

/** 공통코드 드롭다운 값 — 「코드명 [코드값]」. 코드명은 그룹 안에서도 고유하지 않아 코드값으로 가른다 */
export const codeChoice = (label: string, code: string) => `${label} [${code}]`;

/**
 * 공통코드 칸의 글자로 코드를 고른다.
 * 1. 끝에 [코드값] 이 있고, 목록에 그 코드값이면서 앞 글자가 그 코드명인 코드가 있으면 그 코드. 앞 이름도 맞춰 보는
 *    것은 코드값이 그룹마다 따로이기 때문이다 — 분류 드롭다운은 두 그룹을 합친 목록이라, 코드값만 보면 다른 그룹의
 *    「기타 장비 [ETC]」가 이 그룹의 「기타 시설 [ETC]」로 말없이 바뀐다(맞지 않으면 아래로 넘어가 결국 목록 오류).
 * 2. 글자 전체가 코드명이면: 하나면 그 코드, 여럿이면 'ambiguous' — 첫 번째로 고르면 다른 코드로 말없이 저장된다.
 *    이름이 먼저다(어떤 이름이 다른 항목의 코드값과 같아도 화면에 보이는 이름을 따른다). 이름에 대괄호가 든 코드도
 *    2번으로 찾는다.
 * 3. 글자 전체가 코드값이면 그 코드. 못 찾으면 null.
 */
function pick<T extends { code: string; label: string }>(
  list: readonly T[],
  text: string,
): T | 'ambiguous' | null {
  const bracket = /^(.*)\[([^[\]]+)\]$/.exec(text);
  const byBracket = bracket
    ? list.find(
        (c) => c.code === bracket[2].trim() && c.label === bracket[1].trim(),
      )
    : undefined;
  if (byBracket) return byBracket;
  const byLabel = list.filter((c) => c.label === text);
  if (byLabel.length > 1) return 'ambiguous';
  return byLabel[0] ?? list.find((c) => c.code === text) ?? null;
}

const CODE_AMBIGUOUS =
  '이름이 같은 값이 여럿입니다. 목록에서 「코드명 [코드값]」으로 골라 주세요.';

/** 점포 드롭다운 값 — 「점포명 [점포코드]」. 이름이 같은 점포도 코드로 갈린다 */
export const storeChoice = (name: string, code: string) => `${name} [${code}]`;

/**
 * 점포 칸의 글자로 점포를 찾는다.
 * 1. 끝에 [코드] 가 있고 그 코드가 범위 안이면 그 점포(앞 이름은 보지 않는다).
 * 2. 글자 전체가 점포코드면 그 점포 — 점포코드는 점포명보다 먼저다(코드는 겹치지 않는다).
 * 3. 글자 전체가 점포명이면: 열린 점포가 하나면 그 점포, 여럿이면 'ambiguous', 열린 점포가 없으면 폐점 점포(그 사유가
 *    나간다). 이름에 대괄호가 들어간 점포도 3번으로 찾는다.
 * 못 찾으면 null.
 */
function findStore(
  stores: BulkLookups['stores'],
  text: string,
): BulkStore | 'ambiguous' | null {
  const bracket = /\[([^[\]]+)\]$/.exec(text);
  const byBracket = bracket ? stores.get(bracket[1].trim()) : undefined;
  if (byBracket) return byBracket;
  const byCode = stores.get(text);
  if (byCode) return byCode;
  const byName = [...stores.values()].filter((s) => s.name.trim() === text);
  const open = byName.filter((s) => !s.isClosed);
  if (open.length > 1) return 'ambiguous';
  return open[0] ?? byName[0] ?? null;
}

/**
 * 글자 수 — DB(char_length)처럼 코드 포인트로 센다(🧊 같은 확장 평면 글자 하나 = 1자). 등록 화면의 class-validator 는
 * 이형 선택자(U+FE0F 등)를 빼고 세서, ❤️ 같은 글자에서 드물게 1자 덜 센다 — 일괄 등록이 그만큼 엄격하다.
 */
const lengthOf = (v: string) => [...v].length;

const MAX_LENGTH: Partial<Record<BulkField, number>> = {
  name: 100,
  brand: 100,
  manufacturer: 100,
  serialNumber: 100,
  installationLocation: 100,
  vendorName: 100,
  salesRepresentativeName: 50,
  memo: 200,
  inspectionNote: 200,
};

/**
 * 한 줄을 검사한다 — 등록 화면(PL-5)과 같은 규칙. 오류는 칸 순서대로 모두 적고, 하나라도 있으면 저장할 값이 없다.
 * 읽을 수 없던 칸(problems)은 그 사유 하나만 적는다(필수 칸이어도 「입력해 주세요」를 더하지 않는다).
 * 처음 값: 수량 비면 1, 부가세 포함 비면 Y, 점검 주기 비면 없음.
 */
export function checkBulkRow(
  row: BulkRawRow,
  lookups: BulkLookups,
): BulkCheckedRow {
  const problems = row.problems ?? {};
  const byField = new Map<BulkField, string[]>();
  for (const h of BULK_HEADERS) {
    const problem = problems[h.key];
    if (problem) byField.set(h.key, [problem]);
  }
  const fail = (field: BulkField, reason: string) => {
    if (problems[field]) return;
    const list = byField.get(field) ?? [];
    list.push(reason);
    byField.set(field, list);
  };
  /** 칸 글자 — 읽을 수 없던 칸은 빈 글자(사유는 이미 적혀 있다) */
  const raw = (field: BulkField) => (problems[field] ? '' : row.cells[field]);
  const trimmed = (field: BulkField) => raw(field).trim();

  /** 글자 칸 — 앞뒤 공백을 떼고 비면 null. 길이 · NUL 을 본다 */
  const text = (field: BulkField): string | null => {
    const v = trimmed(field);
    if (!NO_NUL.test(v)) {
      fail(field, '쓸 수 없는 문자가 있습니다.');
      return null;
    }
    const max = MAX_LENGTH[field];
    if (max !== undefined && lengthOf(v) > max) {
      fail(field, `${max}자까지 입력할 수 있습니다.`);
      return null;
    }
    return v === '' ? null : v;
  };
  const phone = (field: BulkField): string | null => {
    const digits = raw(field).replace(/[-\s]/g, '');
    if (digits === '') return null;
    if (!/^[0-9]{9,12}$/.test(digits)) {
      fail(field, '숫자 9~12자리로 적어 주세요.');
      return null;
    }
    return digits;
  };
  const date = (field: BulkField): Date | null | undefined => {
    const v = trimmed(field);
    if (v === '') return null;
    const parsed = parseDateOnly(v);
    if (!parsed) {
      fail(field, 'YYYY-MM-DD 로 적어 주세요.');
      return undefined;
    }
    return parsed;
  };

  // 점포 — 「점포명 [점포코드]」(드롭다운 값) · 점포코드 · 범위 안에서 하나뿐인 점포명
  const storeText = trimmed('store');
  const found = storeText ? findStore(lookups.stores, storeText) : null;
  const store = found && found !== 'ambiguous' ? found : undefined;
  if (!storeText) fail('store', '입력해 주세요.');
  else if (found === 'ambiguous')
    fail(
      'store',
      '이름이 같은 점포가 여럿입니다. 목록에서 「점포명 [점포코드]」로 골라 주세요.',
    );
  else if (!store) fail('store', '관리하는 점포가 아닙니다.');
  else if (store.isClosed) fail('store', '폐점 점포에는 등록할 수 없습니다.');

  // 이름 — 필수, 100자
  const nameText = trimmed('name');
  let name: string | null = null;
  if (!nameText) fail('name', '입력해 주세요.');
  else name = text('name');

  // 운영상태 · 그룹 · 분류 — 「코드명 [코드값]」(드롭다운 값) · 하나뿐인 코드명 · 코드값
  const statusText = trimmed('status');
  const statusPick = statusText ? pick(lookups.statuses, statusText) : null;
  const status = statusPick === 'ambiguous' ? null : statusPick;
  if (!statusText) fail('status', '선택해 주세요.');
  else if (statusPick === 'ambiguous') fail('status', CODE_AMBIGUOUS);
  else if (!status) fail('status', '목록에 있는 값을 골라 주세요.');

  const groupText = trimmed('group');
  const groupPick = groupText ? pick(lookups.groups, groupText) : null;
  const group = groupPick === 'ambiguous' ? null : groupPick;
  if (!groupText) fail('group', '선택해 주세요.');
  else if (groupPick === 'ambiguous') fail('group', CODE_AMBIGUOUS);
  else if (!group) fail('group', '목록에 있는 값을 골라 주세요.');

  const categoryText = trimmed('category');
  const categoryPick =
    group && categoryText
      ? pick(lookups.categories[group.code], categoryText)
      : null;
  const category = categoryPick === 'ambiguous' ? null : categoryPick;
  if (!categoryText) fail('category', '선택해 주세요.');
  else if (categoryPick === 'ambiguous') fail('category', CODE_AMBIGUOUS);
  // 그룹이 틀렸으면 적힌 분류가 그룹에 맞는지는 보지 않는다 — 고칠 곳은 그룹이다(비어 있으면 필수 오류는 낸다)
  else if (group && !category)
    fail('category', `「${group.label}」에 없는 분류입니다.`);

  const brand = text('brand');
  const manufacturer = text('manufacturer');
  const serialNumber = text('serialNumber');
  const installationLocation = text('installationLocation');
  const vendorName = text('vendorName');
  const vendorPhone = phone('vendorPhone');
  const salesRepresentativeName = text('salesRepresentativeName');
  const salesRepresentativePhone = phone('salesRepresentativePhone');

  // 단가 — 천 단위 쉼표는 떼고 0 이상 정수 10자리
  const priceText = trimmed('unitPrice').replace(/,(?=\d{3}(\D|$))/g, '');
  let unitPrice: number | null = null;
  if (priceText !== '') {
    if (/^[0-9]{1,10}$/.test(priceText) && Number(priceText) <= UNIT_PRICE_MAX)
      unitPrice = Number(priceText);
    else fail('unitPrice', '0 이상 숫자 10자리까지 적어 주세요.');
  }

  // 수량 — 천 단위 쉼표는 떼고, 비면 1
  const quantityText = trimmed('quantity').replace(/,(?=\d{3}(\D|$))/g, '');
  let quantity = 1;
  if (quantityText !== '') {
    const q = Number(quantityText);
    if (/^[0-9]+$/.test(quantityText) && q >= 1 && q <= QUANTITY_MAX)
      quantity = q;
    else
      fail(
        'quantity',
        `1 ~ ${QUANTITY_MAX.toLocaleString('ko-KR')} 사이로 적어 주세요.`,
      );
  }

  // 부가세 포함 — 비면 Y
  const vatText = trimmed('vatIncluded').toUpperCase();
  let isVatIncluded = true;
  if (vatText === 'N') isVatIncluded = false;
  else if (vatText !== '' && vatText !== 'Y')
    fail('vatIncluded', 'Y 또는 N 으로 적어 주세요.');

  const purchaseDate = date('purchaseDate');
  const installationDate = date('installationDate');
  if (purchaseDate && installationDate && installationDate < purchaseDate)
    fail('installationDate', '구매일보다 앞설 수 없습니다.');

  // 메모 — 공백 · 줄바꿈을 포함해 200자, 공백뿐이면 비운 것
  const memoRaw = raw('memo');
  let memo: string | null = null;
  if (memoRaw.trim() !== '') {
    if (!NO_NUL.test(memoRaw)) fail('memo', '쓸 수 없는 문자가 있습니다.');
    else if (lengthOf(memoRaw) > 200)
      fail('memo', '200자까지 입력할 수 있습니다.');
    else memo = memoRaw;
  }

  const usageExpiryDate = date('usageExpiryDate');
  const warrantyExpiryDate = date('warrantyExpiryDate');

  const cycleText = trimmed('inspectionCycle');
  const cyclePick = cycleText ? pick(lookups.cycles, cycleText) : null;
  const cycle = cyclePick === 'ambiguous' ? null : cyclePick;
  if (cyclePick === 'ambiguous') fail('inspectionCycle', CODE_AMBIGUOUS);
  else if (cycleText && !cycle)
    fail('inspectionCycle', '목록에 있는 값을 골라 주세요.');

  const inspectionNote = text('inspectionNote');
  const serviceCenterPhone = phone('serviceCenterPhone');

  const values: Record<BulkPreviewKey, string> = {
    storeName: store?.name ?? storeText,
    group: group?.label ?? groupText,
    category: category?.label ?? categoryText,
    name: nameText,
    purchaseDate: trimmed('purchaseDate'),
    installationDate: trimmed('installationDate'),
  };
  const errors = BULK_HEADERS.flatMap((h) =>
    (byField.get(h.key) ?? []).map((reason) => `${NAME_OF[h.key]}: ${reason}`),
  );
  if (errors.length) return { isValid: false, values, errors, data: null };
  // 오류가 없으면 필수 칸은 모두 찾았다 — 아니면 fail 을 빠뜨린 버그다(사용자 오류로 가리지 않는다)
  if (!store || !status || !group || !category || !name)
    throw new Error(
      `checkBulkRow: 오류 없이 필수 값이 비었다(행 ${row.rowNumber})`,
    );
  return {
    isValid: true,
    values,
    errors: [],
    data: {
      storeId: store.storeId,
      name,
      facilityStatusCode: status.code,
      facilityGroupCode: group.code,
      facilityCategoryCode: category.code,
      memo,
      brand,
      manufacturer,
      serialNumber,
      installationLocation,
      vendorName,
      vendorPhone,
      salesRepresentativeName,
      salesRepresentativePhone,
      unitPriceAmount: unitPrice,
      quantity,
      totalAmount: totalAmountOf(unitPrice, quantity),
      isVatIncluded,
      purchaseDate: purchaseDate ?? null,
      installationDate: installationDate ?? null,
      usageExpiryDate: usageExpiryDate ?? null,
      warrantyExpiryDate: warrantyExpiryDate ?? null,
      inspectionCycleCode: cycle?.code ?? null,
      inspectionNote,
      serviceCenterPhone,
    },
  };
}

/** 머리글 행 서식 — 목록 엑셀과 같은 9pt · 굵게 · 회색 바탕 */
function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = { name: EXCEL_FONT_NAME, size: EXCEL_FONT_SIZE, bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: EXCEL_HEADER_FILL },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
}

/** 엑셀 열 글자(1 → A, 27 → AA) */
function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26))
    s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * 양식 — 첫 시트 「시설물·장비」(머리글 + 500줄 글자 서식 · 드롭다운), 둘째 시트 「점포 목록」(범위 안 · 폐점 제외, 점포명 순),
 * 숨긴 셋째 시트 「선택값」(드롭다운 목록 — 엑셀 목록 글자 수 한도 255자를 피한다). 분류 드롭다운은 두 그룹의 분류를
 * 합친 것이다 — 그룹에 맞는지는 올릴 때 본다. 모든 칸을 글자 서식으로 둬 엑셀이 0 으로 시작하는 번호 · 날짜를 바꾸지 않게 한다.
 * 목록이 비면(열린 점포 없음 등) 그 칸에는 드롭다운을 걸지 않는다 — 빈 범위 수식은 엑셀이 복구 모드로 연다.
 */
export async function buildBulkTemplate(lookups: BulkLookups): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const main = wb.addWorksheet(SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const storeSheet = wb.addWorksheet(STORE_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const choiceSheet = wb.addWorksheet(CHOICE_SHEET_NAME, { state: 'hidden' });

  main.addRow(BULK_HEADERS.map((h) => h.label));
  styleHeader(main.getRow(1));
  BULK_HEADERS.forEach((h, i) => {
    main.getColumn(i + 1).width = Math.max(12, h.label.length * 2 + 2);
  });

  // 점포명 순(같으면 코드 순) — 사용자는 이름을 보고 고른다. 첫 열이 드롭다운 값 「점포명 [점포코드]」
  const openStores = [...lookups.stores.values()]
    .filter((s) => !s.isClosed)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'ko') ||
        a.storeCode.localeCompare(b.storeCode),
    );
  storeSheet.addRow(['점포', '점포코드', '점포명']);
  styleHeader(storeSheet.getRow(1));
  for (const s of openStores)
    storeSheet.addRow([storeChoice(s.name, s.storeCode), s.storeCode, s.name]);
  storeSheet.getColumn(1).width = 50;
  storeSheet.getColumn(2).width = 14;
  storeSheet.getColumn(3).width = 40;

  // 선택값 시트 — 열마다 목록 하나, 1행은 이름
  const lists: { field: BulkField; title: string; items: string[] }[] = [
    {
      field: 'status',
      title: '운영상태',
      items: lookups.statuses.map((c) => codeChoice(c.label, c.code)),
    },
    {
      field: 'group',
      title: '그룹',
      items: lookups.groups.map((g) => codeChoice(g.label, g.code)),
    },
    {
      field: 'category',
      title: '분류',
      // 두 그룹에 같은 코드값 · 같은 코드명이 있으면 한 줄로 합친다 — 그룹에 맞는지는 올릴 때 본다
      items: [
        ...new Set(
          lookups.groups.flatMap((g) =>
            lookups.categories[g.code].map((c) => codeChoice(c.label, c.code)),
          ),
        ),
      ],
    },
    {
      field: 'inspectionCycle',
      title: '점검 주기',
      items: lookups.cycles.map((c) => codeChoice(c.label, c.code)),
    },
    { field: 'vatIncluded', title: '부가세 포함', items: ['Y', 'N'] },
  ];
  const formulaOf = new Map<BulkField, string>();
  lists.forEach((list, i) => {
    const col = i + 1;
    choiceSheet.getCell(1, col).value = list.title;
    list.items.forEach((item, j) => {
      choiceSheet.getCell(j + 2, col).value = item;
    });
    if (list.items.length) {
      const letter = columnLetter(col);
      formulaOf.set(
        list.field,
        `'${CHOICE_SHEET_NAME}'!$${letter}$2:$${letter}$${list.items.length + 1}`,
      );
    }
  });
  if (openStores.length)
    formulaOf.set(
      'store',
      `'${STORE_SHEET_NAME}'!$A$2:$A$${openStores.length + 1}`,
    );

  for (let r = 2; r <= LAST_ROW; r++) {
    const row = main.getRow(r);
    for (let c = 1; c <= BULK_HEADERS.length; c++) row.getCell(c).numFmt = '@';
    for (const [field, formula] of formulaOf) {
      row.getCell(COLUMN_OF[field]).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [formula],
        // 점포는 오류 알림 없이 목록 밖 값(점포코드만 · 점포명만)도 적게 둔다 — 못 찾으면 올릴 때 사유로 알린다
        showErrorMessage: field !== 'store',
        errorStyle: 'stop',
        error: '목록에 있는 값을 골라 주세요.',
      };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * 오류 파일 — 올린 파일의 첫 시트 끝에 「오류 사유」 열을 더하고 오류 줄에만 사유를 줄바꿈으로 잇는다. 고쳐 다시 올린
 * 오류 파일이면 옛 사유를 지우고 새로 적는다. readBulkFile 이 검사를 마친 같은 파일(source)을 받는다.
 */
export async function buildBulkErrorFile(
  { source }: Pick<ParsedBulkFile, 'source'>,
  errorsByRow: ReadonlyMap<number, readonly string[]>,
): Promise<Buffer> {
  // 올린 파일을 다시 여는 일이라 읽기와 같은 worker 에서 한다(메모리 · 시간 상한). 실제 있는 행에만 쓴다
  return writeErrorColumnInWorker(source, BULK_HEADERS.length, errorsByRow, {
    header: ERROR_HEADER,
    font: { name: EXCEL_FONT_NAME, size: EXCEL_FONT_SIZE, bold: true },
    fill: {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: EXCEL_HEADER_FILL },
    },
  });
}
