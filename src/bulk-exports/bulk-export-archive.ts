import { zipSync, type Zippable } from 'fflate';
import { kstDateTime } from '../common/kst-date-time';
import { DB_ENUMS } from '../enums/db-enums.generated';
import { payslipPdfFileName } from '../payslips/payslip-pdf';
import { safeName } from './bulk-export-policy';

// 직원 자료 일괄 저장 zip 의 구성(계획 docs/plans/2026-10-29-staff-records-export.md 「파일 만들기」). 읽어 온 값 → 경로 · CSV 는
// 여기서 정하고(archivePlan), 저장소 파일 읽기 · 급여명세서 PDF 그리기는 서비스가 한다. 직원은 이름 · 휴대전화번호까지만 담는다 —
// 주민등록번호 · 신고 정보 · 확인자료 · 동의 기록은 입력에 없다.

type Cell = string | number | null;

export interface ArchiveInput {
  storeNames: ReadonlyMap<number, string>;
  staff: {
    staffMemberId: number;
    storeId: number;
    name: string;
    phone: string;
  }[];
  contracts: {
    contractId: number;
    staffMemberId: number;
    status: string | null;
    contractMethod: string | null;
    employmentType: string | null;
    jobTitle: string | null;
    startDate: Date | null;
    endDate: Date | null;
    wageAmount: number | null;
    sentAt: Date | null;
    documents: { kind: string; storageKey: string }[];
  }[];
  attendance: {
    attendanceRecordId: number;
    staffMemberId: number;
    kind: string;
    recordedAt: Date;
    entryMethod: string;
    proxyBy: number | null;
    proxyReason: string | null;
    reviewReason: string | null;
    corrections: {
      beforeValue: unknown;
      afterValue: unknown;
      reason: string;
      correctedBy: number;
      correctedAt: Date;
    }[];
  }[];
  schedules: {
    staffMemberId: number;
    startAt: Date;
    endAt: Date;
    breakMinutes: number;
  }[];
  payslips: {
    payslipId: number;
    staffMemberId: number;
    periodStartDate: string;
    periodEndDate: string;
    employmentType: string;
    grossPayAmount: number | null;
    totalDeductionAmount: number | null;
    netPayAmount: number | null;
    sentAt: Date | null;
  }[];
  /** 관리자 이름(없으면 로그인 아이디) */
  adminName: (adminAccountId: number | null) => string;
}

export interface ArchivePlan {
  /** 맨 위 CSV — 이름 → 내용 */
  csv: Map<string, Buffer>;
  /** 저장소에서 읽어 넣을 근로계약서 파일 */
  files: { path: string; storageKey: string }[];
  /** 그려 넣을 급여명세서 PDF */
  payslips: { path: string; payslipId: number; staffName: string }[];
}

const BOM = '﻿';
// 엑셀이 수식으로 읽는 첫 글자 — 직원 이름 · 사유는 사람이 적은 값이라 작은따옴표를 붙여 글자로 둔다(CSV injection)
const FORMULA = /^[=+\-@\t\r]/;

/** UTF-8 BOM(엑셀이 한글을 깨뜨리지 않게) · CRLF CSV */
export function toCsv(header: string[], rows: Cell[][]): Buffer {
  const cell = (v: Cell) => {
    if (v === null) return '';
    let s = String(v);
    if (typeof v === 'string' && FORMULA.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [header, ...rows].map((r) => r.map(cell).join(','));
  return Buffer.from(BOM + lines.map((l) => `${l}\r\n`).join(''), 'utf8');
}

const label = (name: string, value: string | null) =>
  value === null
    ? null
    : (DB_ENUMS[name]?.find(([v]) => v === value)?.[1] ?? value);
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const at = (d: Date | null) => (d ? kstDateTime(d) : null);

/** 보정 이력의 값 { checkInAt, checkOutAt } → 「출근 2026-10-01 09:02 · 퇴근 없음」(날짜까지 — 날이 바뀐 보정도 보이게) */
function correctionText(value: unknown): string {
  const v = (value ?? {}) as {
    checkInAt?: string | null;
    checkOutAt?: string | null;
  };
  const one = (iso?: string | null) =>
    iso ? kstDateTime(new Date(iso)) : '없음';
  return `출근 ${one(v.checkInAt)} · 퇴근 ${one(v.checkOutAt)}`;
}

const STAFF_HEADER = ['점포', '직원 레코드 ID', '이름', '휴대전화번호'];

export function archivePlan(input: ArchiveInput): ArchivePlan {
  const staffById = new Map(input.staff.map((s) => [s.staffMemberId, s]));
  const storeName = (storeId: number) =>
    input.storeNames.get(storeId) ?? String(storeId);
  const who = (staffMemberId: number): Cell[] => {
    const s = staffById.get(staffMemberId)!;
    return [storeName(s.storeId), s.staffMemberId, s.name, s.phone];
  };
  const folder = (staffMemberId: number) => {
    const s = staffById.get(staffMemberId)!;
    return `${safeName(storeName(s.storeId)) || s.storeId}/${safeName(s.name)}_${s.staffMemberId}`;
  };
  const used = new Set<string>();
  const unique = (path: string) => {
    let out = path;
    for (let n = 2; used.has(out); n++)
      out = path.replace(/(\.[^./]+)?$/, (ext) => ` (${n})${ext}`);
    used.add(out);
    return out;
  };

  const csv = new Map<string, Buffer>();
  csv.set(
    '근로계약_목록.csv',
    toCsv(
      [
        ...STAFF_HEADER,
        '계약 ID',
        '상태',
        '계약 방식',
        '고용 형태',
        '직무',
        '계약 시작일',
        '계약 종료일',
        '시급',
        '발송 일시',
      ],
      input.contracts.map((c) => [
        ...who(c.staffMemberId),
        c.contractId,
        label('ContractStatus', c.status),
        label('ContractMethod', c.contractMethod),
        label('EmploymentType', c.employmentType),
        c.jobTitle,
        day(c.startDate),
        day(c.endDate),
        c.wageAmount,
        at(c.sentAt),
      ]),
    ),
  );
  csv.set(
    '출퇴근_기록.csv',
    toCsv(
      [
        ...STAFF_HEADER,
        '기록 ID',
        '구분',
        '시각',
        '등록 방식',
        '대신 등록한 관리자',
        '대신 등록 사유',
        '확인 필요 사유',
      ],
      input.attendance.map((r) => [
        ...who(r.staffMemberId),
        r.attendanceRecordId,
        label('AttendanceKind', r.kind),
        at(r.recordedAt),
        label('AttendanceEntryMethod', r.entryMethod),
        r.entryMethod === 'PROXY' ? input.adminName(r.proxyBy) : null,
        r.proxyReason,
        label('AttendanceReviewReason', r.reviewReason),
      ]),
    ),
  );
  csv.set(
    '출퇴근_보정_이력.csv',
    toCsv(
      [
        ...STAFF_HEADER,
        '기록 ID',
        '구분',
        '보정 전',
        '보정 후',
        '사유',
        '보정한 관리자',
        '보정 일시',
      ],
      input.attendance.flatMap((r) =>
        r.corrections.map((c) => [
          ...who(r.staffMemberId),
          r.attendanceRecordId,
          label('AttendanceKind', r.kind),
          correctionText(c.beforeValue),
          correctionText(c.afterValue),
          c.reason,
          input.adminName(c.correctedBy),
          at(c.correctedAt),
        ]),
      ),
    ),
  );
  csv.set(
    '급여명세서_목록.csv',
    toCsv(
      [
        ...STAFF_HEADER,
        '명세서 ID',
        '급여 기간 시작일',
        '급여 기간 종료일',
        '고용 형태',
        '지급 합계',
        '공제 합계',
        '실지급액',
        '발송 일시',
      ],
      input.payslips.map((p) => [
        ...who(p.staffMemberId),
        p.payslipId,
        p.periodStartDate,
        p.periodEndDate,
        label('EmploymentType', p.employmentType),
        p.grossPayAmount,
        p.totalDeductionAmount,
        p.netPayAmount,
        at(p.sentAt),
      ]),
    ),
  );
  csv.set(
    '근무스케줄.csv',
    toCsv(
      [...STAFF_HEADER, '시작', '끝', '휴게(분)'],
      input.schedules.map((w) => [
        ...who(w.staffMemberId),
        at(w.startAt),
        at(w.endAt),
        w.breakMinutes,
      ]),
    ),
  );

  const files = input.contracts.flatMap((c) =>
    c.documents.map((d) => ({
      path: unique(
        `${folder(c.staffMemberId)}/근로계약서/${c.contractId}_${label('ContractDocumentKind', d.kind)}.${d.storageKey.split('.').pop()}`,
      ),
      storageKey: d.storageKey,
    })),
  );
  const payslips = input.payslips.map((p) => {
    const staffName = staffById.get(p.staffMemberId)!.name;
    return {
      path: unique(
        `${folder(p.staffMemberId)}/급여명세서/${payslipPdfFileName(p, staffName).name}`,
      ),
      payslipId: p.payslipId,
      staffName,
    };
  });
  return { csv, files, payslips };
}

/**
 * zip 하나로 묶는다. PDF · 이미지는 이미 압축된 형식이라 그대로 넣고(level 0), CSV 는 압축한다.
 * ponytail: 파일 전부와 zip 을 메모리에 한 번에 둔다 — 범위의 근로계약서 · 명세서 합이 수백 MB 를 넘으면 힙이 모자란다.
 * 그때 fflate 의 스트리밍 Zip 으로 조각을 만들어 S3 multipart upload(@aws-sdk/lib-storage Upload)로 바로 흘려 보낸다.
 */
export function zipArchive(
  entries: { path: string; data: Uint8Array }[],
): Buffer {
  const tree: Zippable = {};
  for (const { path, data } of entries)
    tree[path] = [data, { level: /\.(?:pdf|jpe?g|png)$/i.test(path) ? 0 : 6 }];
  return Buffer.from(zipSync(tree));
}
