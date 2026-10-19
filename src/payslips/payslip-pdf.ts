import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { DB_ENUMS } from '../enums/db-enums.generated';
import type {
  MyPayslipDetailResponseDto,
  MyPayslipItemDto,
} from './dto/my-payslip.response.dto';

// 직원 앱 「명세서 내보내기」(PAY-2)의 PDF. 직원 앱 급여 상세(whale-erp-staff `(app)/pay/[payslipId]`)와 같은 칸 · 같은 줄 규칙이다.
// 데이터 → 칸(payslipPdfModel)과 칸 → PDF(renderPayslipPdf)를 나눠 칸은 단위 테스트로 본다.
// 글꼴은 직원 앱과 같은 Pretendard(1.3.9, OFL — assets/fonts/Pretendard-LICENSE.txt). nest-cli.json assets 가 dist 로 복사한다.

const FONT_DIR = join(__dirname, 'assets', 'fonts');
const REGULAR = join(FONT_DIR, 'Pretendard-Regular.otf');
const BOLD = join(FONT_DIR, 'Pretendard-Bold.otf');

const TIME_ZONE = 'Asia/Seoul';
/** 3.3% 를 켜면 빠지는 기본 공제(PAY-03) — 직원 앱 · 관리자 화면의 isItemShown 과 같다. */
const REPLACED_BY_WITHHOLDING = new Set(['INCOME_TAX', 'LOCAL_INCOME_TAX']);

export interface PayslipPdfRow {
  name: string;
  /** 이름 아래 작은 글자 — 비과세 · 원천징수 끝자리 안내(PAY-7) */
  note: string | null;
  amount: string;
}

export interface PayslipPdfModel {
  title: string;
  info: [string, string][];
  earnings: PayslipPdfRow[];
  deductions: PayslipPdfRow[];
  totals: [string, string][];
  net: string;
}

const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;

/** 직원 앱 isItemShown — 원천징수 둘은 3.3% 를 켰을 때만, 그때 소득세 · 지방소득세는 뺀다. */
function isShown(item: MyPayslipItemDto, withholding: boolean): boolean {
  if (item.itemCategory === 'WITHHOLDING') return withholding;
  if (item.itemCategory === 'BASIC')
    return !(withholding && REPLACED_BY_WITHHOLDING.has(item.itemCode));
  return true;
}

const rowOf = (item: MyPayslipItemDto): PayslipPdfRow => ({
  name: item.itemName,
  note: item.isTaxFree
    ? '비과세'
    : item.itemCategory === 'WITHHOLDING'
      ? '끝자리 세무 확인 대기(PAY-7)'
      : null,
  // 직원 앱과 같다: 고친 값 > 계산값 > 0. 합계는 저장된 값을 쓴다.
  amount: won(item.adjustedAmount ?? item.calculatedAmount ?? 0),
});

const ymd = (date: string) => date.split('-').map(Number);

/** 「2026년 8월 1일 – 8월 31일」. 해를 넘으면 끝에도 해를 적는다(직원 앱 periodLabel). */
function periodLabel(start: string, end: string): string {
  const [sy, sm, sd] = ymd(start);
  const [ey, em, ed] = ymd(end);
  return `${sy}년 ${sm}월 ${sd}일 – ${ey === sy ? '' : `${ey}년 `}${em}월 ${ed}일`;
}

/** 「2026년 8월 10일」(한국 날짜). */
function dateLabel(at: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}년 ${p.month}월 ${p.day}일`;
}

/** 명세서 → PDF 칸. 직원 앱 상세와 같은 줄 · 같은 금액 규칙. */
export function payslipPdfModel(
  p: MyPayslipDetailResponseDto,
  staffName: string,
): PayslipPdfModel {
  const sends = p.logs
    .filter((l) => l.logType === 'SEND')
    .sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  const last = sends.at(-1);
  const employmentType =
    DB_ENUMS.EmploymentType.find(([v]) => v === p.employmentType)?.[1] ??
    p.employmentType;
  const items = p.items.filter((i) => isShown(i, p.isWithholdingApplied));
  return {
    title: '급여명세서',
    info: [
      ['급여 기간', periodLabel(p.periodStartDate, p.periodEndDate)],
      ['직원', staffName],
      ['근무지', p.storeName],
      ['계약 유형', employmentType],
      [
        '발송일',
        last
          ? `${dateLabel(last.changedAt)}${sends.length > 1 ? ' (다시 발송)' : ''}`
          : '-',
      ],
    ],
    earnings: items.filter((i) => i.itemCategory === 'EARNING').map(rowOf),
    deductions: items.filter((i) => i.itemCategory !== 'EARNING').map(rowOf),
    totals: [
      ['지급 합계', won(p.grossPayAmount)],
      ['공제 합계', won(p.totalDeductionAmount)],
    ],
    net: won(p.netPayAmount),
  };
}

/**
 * 내려받을 파일 이름. name 은 `급여명세서_2026-07_유하람.pdf`(filename*), ascii 는 한글을 못 읽는 곳의 대신 이름(filename).
 * 파일 이름에 쓸 수 없는 글자(경로 · 따옴표 · 제어 문자)는 밑줄로 바꾼다.
 */
export function payslipPdfFileName(
  p: Pick<MyPayslipDetailResponseDto, 'payslipId' | 'periodStartDate'>,
  staffName: string,
): { name: string; ascii: string } {
  const month = p.periodStartDate.slice(0, 7);
  // eslint-disable-next-line no-control-regex
  const safe = staffName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return {
    name: `급여명세서_${month}_${safe || p.payslipId}.pdf`,
    ascii: `payslip_${month}_${p.payslipId}.pdf`,
  };
}

/**
 * Content-Disposition 값. filename 은 ASCII 대신 이름, filename* 는 RFC 5987(UTF-8 퍼센트 인코딩 — encodeURIComponent 가 남기는
 * `'()*` 도 인코딩한다).
 */
export function contentDisposition({
  name,
  ascii,
}: {
  name: string;
  ascii: string;
}): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#d1d5db';

/** 칸 → A4 PDF 한 장(넘치면 다음 장). 글꼴은 쓴 글자만 넣는다(pdfkit 서브셋). */
export function renderPayslipPdf(model: PayslipPdfModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 56,
    info: { Title: model.title, Producer: 'WHALE ERP' },
  });
  doc.registerFont('R', REGULAR);
  doc.registerFont('B', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const rule = (color = LINE) => {
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .lineWidth(0.7)
      .strokeColor(color)
      .stroke();
  };
  /** 왼쪽 이름(아래 작은 글자) · 오른쪽 금액 한 줄 */
  const pair = (
    name: string,
    value: string,
    { bold = false, size = 11, note = null as string | null } = {},
  ) => {
    const top = doc.y;
    doc
      .font(bold ? 'B' : 'R')
      .fontSize(size)
      .fillColor(INK);
    doc.text(value, left, top, { width, align: 'right' });
    doc.text(name, left, top, { width: width * 0.65 });
    if (note)
      doc
        .font('R')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(note, left, doc.y + 1);
    doc.moveDown(0.45);
  };
  const table = (
    head: string,
    rows: PayslipPdfRow[],
    total: [string, string],
  ) => {
    doc.moveDown(0.8);
    doc.font('B').fontSize(13).fillColor(INK).text(head, left, doc.y);
    doc.moveDown(0.3);
    rule(INK);
    doc.moveDown(0.5);
    if (rows.length === 0)
      doc
        .font('R')
        .fontSize(10)
        .fillColor(MUTED)
        .text('항목 없음', left, doc.y)
        .moveDown(0.45);
    for (const r of rows) pair(r.name, r.amount, { note: r.note });
    rule();
    doc.moveDown(0.5);
    pair(total[0], total[1], { bold: true });
  };

  doc.font('B').fontSize(22).fillColor(INK).text(model.title, left, doc.y);
  doc.moveDown(0.8);
  for (const [label, value] of model.info) {
    const top = doc.y;
    doc
      .font('R')
      .fontSize(10.5)
      .fillColor(MUTED)
      .text(label, left, top, { width: 80 });
    doc
      .font('R')
      .fontSize(10.5)
      .fillColor(INK)
      .text(value, left + 90, top, { width: width - 90 });
    doc.moveDown(0.25);
  }
  table('지급 항목', model.earnings, model.totals[0]);
  table('공제 항목', model.deductions, model.totals[1]);

  doc.moveDown(1);
  rule(INK);
  doc.moveDown(0.6);
  pair('실지급액', model.net, { bold: true, size: 16 });
  doc.moveDown(1.2);
  doc
    .font('R')
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(
      '급여 지급은 이 명세서로 처리하지 않습니다. 실제 지급은 회사의 지급 절차를 따릅니다.',
      left,
      doc.y,
      { width },
    );
  doc.end();
  return done;
}
