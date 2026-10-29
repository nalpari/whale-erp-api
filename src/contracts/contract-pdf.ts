import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { dateLabel, type ContractArticle } from './contract-template';

// 근로계약서 보낸 원본 · 처리 완료본 PDF(WHALEERP-131). 조항은 직원 앱 화면과 같은 템플릿(contract-template)에서 오고, 이 파일은
// 끝의 사용자 · 근로자 칸과 서명을 더한다. 데이터 → 칸(contractPdfModel)과 칸 → PDF(renderContractPdf)를 나눠 칸은 단위 테스트로 본다.
// 글꼴은 급여명세서 PDF 와 같은 Pretendard(payslips/assets/fonts, nest-cli.json assets 가 dist 로 복사한다).

const FONT_DIR = join(__dirname, '..', 'payslips', 'assets', 'fonts');
const REGULAR = join(FONT_DIR, 'Pretendard-Regular.otf');
const BOLD = join(FONT_DIR, 'Pretendard-Bold.otf');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type ContractPdfKind = 'SENT_ORIGINAL' | 'SIGNED_COPY';

export interface ContractPdfInput {
  kind: ContractPdfKind;
  contractId: number;
  heading: string;
  articles: ContractArticle[];
  /** 사용자 칸 — 처리 완료본은 날인 때 고정한 값, 보낸 원본 · 고정 전 체결 계약은 만드는 때의 점포 정보 */
  employer: {
    name: string;
    ceoName: string | null;
    registrationNumber: string | null;
    address: string | null;
    addressDetail: string | null;
    phone: string | null;
  };
  worker: {
    name: string;
    /** YYYY-MM-DD */
    birthDate: string | null;
    address: string | null;
    addressDetail: string | null;
    phone: string | null;
  };
  sentAt: Date;
  /** 처리 완료본의 날인 시각(체결 이력의 처리 시각) */
  signedAt: Date | null;
}

export interface ContractPdfModel {
  title: string;
  articles: ContractArticle[];
  dateLine: [string, string];
  employer: [string, string][];
  worker: [string, string][];
  /** 서명 칸에 서명 이미지를 넣는가(처리 완료본) */
  signed: boolean;
  note: string | null;
}

const kstIso = (at: Date) =>
  new Date(at.getTime() + KST_OFFSET_MS).toISOString();
const kstDate = (at: Date) => dateLabel(kstIso(at).slice(0, 10));

/** 사업자등록번호 10자리 → 123-45-67890 */
const bizNumberText = (n: string) =>
  /^\d{10}$/.test(n) ? `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}` : n;

/** 숫자만 저장한 전화번호를 끊어 쓴다 — 서울(02) · 휴대전화 · 지역 번호. 모양이 다르면 그대로 */
function phoneText(p: string): string {
  const m = p.startsWith('02')
    ? /^(02)(\d{3,4})(\d{4})$/.exec(p)
    : /^(0\d{2}|050\d)(\d{3,4})(\d{4})$/.exec(p);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : p;
}

const joinAddress = (a: string | null, detail: string | null) =>
  a ? [a, detail].filter(Boolean).join(' ') : null;

const or = (v: string | null) => (v === null || v === '' ? '-' : v);

export function contractPdfModel(input: ContractPdfInput): ContractPdfModel {
  const { employer: e, worker: w } = input;
  const signed = input.kind === 'SIGNED_COPY';
  return {
    title: input.heading,
    articles: input.articles,
    dateLine:
      signed && input.signedAt
        ? ['계약 체결일', kstDate(input.signedAt)]
        : ['발송일', kstDate(input.sentAt)],
    employer: [
      ['상호', e.name],
      ['대표자', or(e.ceoName)],
      [
        '사업자등록번호',
        or(e.registrationNumber && bizNumberText(e.registrationNumber)),
      ],
      ['소재지', or(joinAddress(e.address, e.addressDetail))],
      ['전화번호', or(e.phone && phoneText(e.phone))],
    ],
    worker: [
      ['성명', w.name],
      ['생년월일', or(w.birthDate && dateLabel(w.birthDate))],
      ['주소', or(joinAddress(w.address, w.addressDetail))],
      ['연락처', or(w.phone && phoneText(w.phone))],
    ],
    signed,
    note: signed
      ? null
      : '근로자가 서명하기 전에 보낸 원본입니다. 체결된 계약서는 처리 완료본입니다.',
  };
}

/** 내려받으면 저장되는 이름. 보낸 원본은 발송마다 하나라 발송 시각(한국, 분까지)을 붙인다 */
export function contractPdfFileName(
  input: Pick<ContractPdfInput, 'kind' | 'contractId' | 'sentAt'>,
): string {
  if (input.kind === 'SIGNED_COPY')
    return `근로계약서-처리완료본-${input.contractId}.pdf`;
  const at = kstIso(input.sentAt).slice(0, 16).replace(/\D/g, '');
  return `근로계약서-보낸원본-${input.contractId}-${at}.pdf`;
}

const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#d1d5db';

/** 칸 → A4 PDF(넘치면 다음 장). 처리 완료본이면 근로자 서명 칸에 서명 PNG 를 넣는다. 글꼴은 쓴 글자만 넣는다(pdfkit 서브셋). */
export function renderContractPdf(
  model: ContractPdfModel,
  signature: Buffer | null,
): Promise<Buffer> {
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
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  /** 다음에 그릴 높이가 이 장에 남지 않으면 넘긴다 — 표 줄 · 값 줄은 좌표로 그려 pdfkit 이 스스로 넘기지 않는다 */
  const ensure = (height: number) => {
    if (doc.y + height > bottom()) doc.addPage();
  };
  const rule = (color = LINE) => {
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .lineWidth(0.7)
      .strokeColor(color)
      .stroke();
  };
  /** 값 줄 하나의 높이 — 긴 주소는 여러 줄로 접힌다 */
  const rowHeight = (labelText: string, value: string, labelWidth = 110) => {
    doc.font('R').fontSize(10);
    return Math.max(
      doc.heightOfString(value, { width: width - labelWidth }),
      doc.heightOfString(labelText, { width: labelWidth - 8 }),
    );
  };
  const row = (labelText: string, value: string, labelWidth = 110) => {
    const height = rowHeight(labelText, value, labelWidth);
    ensure(height + 4);
    const top = doc.y;
    doc.fillColor(MUTED).text(labelText, left, top, { width: labelWidth - 8 });
    doc
      .fillColor(INK)
      .text(value, left + labelWidth, top, { width: width - labelWidth });
    doc.y = top + height + 4;
  };

  doc.font('B').fontSize(20).fillColor(INK).text(model.title, left, doc.y, {
    width,
    align: 'center',
  });
  doc.moveDown(1);

  for (const article of model.articles) {
    const [first, ...rest] = article.blocks;
    doc.moveDown(0.4);
    ensure(30);
    // 첫 문장은 제목 뒤에 잇는다(직원 앱과 같다)
    doc
      .font('B')
      .fontSize(10.5)
      .fillColor(INK)
      .text(`${article.title} `, left, doc.y, {
        width,
        continued: first?.type === 'TEXT',
      });
    if (first?.type === 'TEXT') doc.font('R').text(first.text);
    for (const block of first?.type === 'TEXT' ? rest : article.blocks) {
      doc.moveDown(0.3);
      if (block.type === 'TEXT')
        doc
          .font('R')
          .fontSize(10.5)
          .fillColor(INK)
          .text(block.text, left, doc.y, { width });
      else if (block.type === 'VALUES')
        for (const v of block.values) row(v.label, v.value);
      else {
        const cols = [0.12, 0.17, 0.17, 0.3, 0.24].map((f) => f * width);
        const line = (cells: string[], color: string, bold = false) => {
          ensure(16);
          const top = doc.y;
          let x = left;
          doc
            .font(bold ? 'B' : 'R')
            .fontSize(9.5)
            .fillColor(color);
          cells.forEach((cell, i) => {
            doc.text(cell, x, top, {
              width: cols[i] - 4,
              align: i === cells.length - 1 ? 'right' : 'left',
            });
            x += cols[i];
          });
          doc.y = top + 15;
        };
        // 머리글만 앞 장에 남지 않게 표 전체(머리글 + 일곱 줄)가 들어갈 자리를 먼저 본다
        ensure(15 * (block.tableRows.length + 1) + 4);
        line(block.header, MUTED, true);
        rule();
        doc.y += 3;
        for (const r of block.tableRows) line(r.cells, r.off ? MUTED : INK);
      }
    }
  }

  doc.moveDown(1.2);
  // 체결일 · 사용자 · 근로자 칸 · 서명 칸은 한 장에 둔다 — 줄 높이를 재서 모자라면 통째로 다음 장으로(긴 주소는 여러 줄)
  const parties = [model.dateLine, ...model.employer, ...model.worker];
  ensure(
    parties.reduce((sum, [l, v]) => sum + rowHeight(l, v) + 4, 0) +
      // 구분선 · 칸 사이 여백 · 머리글 둘 · 서명 칸 · 안내문
      160,
  );
  rule(INK);
  doc.moveDown(0.6);
  row(model.dateLine[0], model.dateLine[1]);
  doc.moveDown(0.6);
  for (const [head, rows] of [
    ['사용자', model.employer],
    ['근로자', model.worker],
  ] as const) {
    doc.font('B').fontSize(11).fillColor(INK).text(head, left, doc.y);
    doc.moveDown(0.3);
    for (const [l, v] of rows) row(l, v);
    doc.moveDown(0.6);
  }
  // 근로자 서명 칸 — 보낸 원본은 비운다
  const boxW = 150;
  const boxH = 60;
  ensure(boxH + 10);
  const top = doc.y;
  doc.font('R').fontSize(10).fillColor(MUTED).text('근로자 서명', left, top);
  doc
    .rect(left + 110, top, boxW, boxH)
    .lineWidth(0.7)
    .strokeColor(LINE)
    .stroke();
  if (model.signed && signature)
    doc.image(signature, left + 114, top + 4, {
      fit: [boxW - 8, boxH - 8],
      align: 'center',
      valign: 'center',
    });
  doc.y = top + boxH + 10;
  if (model.note)
    doc
      .font('R')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(model.note, left, doc.y, { width });

  doc.end();
  return done;
}
