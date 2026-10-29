import sharp from 'sharp';
import {
  type ContractPdfInput,
  contractPdfFileName,
  contractPdfModel,
  renderContractPdf,
} from './contract-pdf';

const input: ContractPdfInput = {
  kind: 'SIGNED_COPY',
  contractId: 7,
  heading: '근로계약서 · 파트타이머',
  articles: [
    { title: '제1조(근로계약기간)', blocks: [{ type: 'TEXT', text: '…' }] },
  ],
  employer: {
    name: '고래상회',
    ceoName: '김대표',
    registrationNumber: '1234567890',
    address: '서울 강남구 테헤란로 1',
    addressDetail: '2층',
    phone: '0212345678',
  },
  worker: {
    name: '홍길동',
    birthDate: '2000-01-02',
    address: '서울 마포구 월드컵로 2',
    addressDetail: null,
    phone: '01012345678',
  },
  // 한국 시각 2026-10-30 00:30 — UTC 날짜는 하루 앞이다
  sentAt: new Date('2026-10-20T01:00:00Z'),
  signedAt: new Date('2026-10-29T15:30:00Z'),
};

describe('contractPdfModel (보낸 원본 · 처리 완료본, WHALEERP-131)', () => {
  it('처리 완료본은 체결일(한국 날짜)과 사용자 · 근로자 칸, 번호는 끊어 쓴다', () => {
    expect(contractPdfModel(input)).toEqual({
      title: '근로계약서 · 파트타이머',
      articles: input.articles,
      dateLine: ['계약 체결일', '2026년 10월 30일'],
      employer: [
        ['상호', '고래상회'],
        ['대표자', '김대표'],
        ['사업자등록번호', '123-45-67890'],
        ['소재지', '서울 강남구 테헤란로 1 2층'],
        ['전화번호', '02-1234-5678'],
      ],
      worker: [
        ['성명', '홍길동'],
        ['생년월일', '2000년 1월 2일'],
        ['주소', '서울 마포구 월드컵로 2'],
        ['연락처', '010-1234-5678'],
      ],
      signed: true,
      note: null,
    });
  });

  it('보낸 원본은 발송일 · 서명 칸 비움 · 서명 전 안내, 빈 칸은 -', () => {
    const m = contractPdfModel({
      ...input,
      kind: 'SENT_ORIGINAL',
      signedAt: null,
      employer: { ...input.employer, ceoName: null, registrationNumber: null },
      worker: { ...input.worker, address: null, birthDate: null },
    });
    expect(m.dateLine).toEqual(['발송일', '2026년 10월 20일']);
    expect(m.signed).toBe(false);
    expect(m.note).toBe(
      '근로자가 서명하기 전에 보낸 원본입니다. 체결된 계약서는 처리 완료본입니다.',
    );
    expect(m.employer[1]).toEqual(['대표자', '-']);
    expect(m.employer[2]).toEqual(['사업자등록번호', '-']);
    expect(m.worker[1]).toEqual(['생년월일', '-']);
    expect(m.worker[2]).toEqual(['주소', '-']);
  });

  it('파일 이름 — 처리 완료본은 계약마다 하나, 보낸 원본은 발송 시각(한국)을 붙인다', () => {
    expect(contractPdfFileName(input)).toBe('근로계약서-처리완료본-7.pdf');
    expect(contractPdfFileName({ ...input, kind: 'SENT_ORIGINAL' })).toBe(
      '근로계약서-보낸원본-7-202610201000.pdf',
    );
  });
});

describe('renderContractPdf', () => {
  it('PDF 를 만들고, 처리 완료본이면 서명 이미지를 넣는다', async () => {
    const signature = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const signed = await renderContractPdf(contractPdfModel(input), signature);
    expect(signed.subarray(0, 5).toString()).toBe('%PDF-');
    expect(signed.toString('latin1')).toContain('/Subtype /Image');

    const sent = await renderContractPdf(
      contractPdfModel({ ...input, kind: 'SENT_ORIGINAL', signedAt: null }),
      null,
    );
    expect(sent.subarray(0, 5).toString()).toBe('%PDF-');
    expect(sent.toString('latin1')).not.toContain('/Subtype /Image');
  });
});
