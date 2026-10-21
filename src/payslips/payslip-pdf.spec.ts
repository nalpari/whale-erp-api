import type { MyPayslipDetailResponseDto } from './dto/my-payslip.response.dto';
import {
  contentDisposition,
  payslipPdfFileName,
  payslipPdfModel,
  renderPayslipPdf,
} from './payslip-pdf';

const item = (
  payslipItemId: number,
  itemCategory: 'EARNING' | 'BASIC' | 'ADDITIONAL' | 'WITHHOLDING',
  itemCode: string,
  itemName: string,
  over: object = {},
) => ({
  payslipItemId,
  itemCategory,
  itemCode,
  itemName,
  isTaxFree: false,
  calculatedAmount: null,
  adjustedAmount: null,
  isEntered: true,
  ...over,
});

const detail = (
  over: Partial<MyPayslipDetailResponseDto> = {},
): MyPayslipDetailResponseDto => ({
  payslipId: 40,
  periodStartDate: '2026-07-01',
  periodEndDate: '2026-07-31',
  employmentType: 'PART_TIME',
  status: 'SENT',
  correcting: false,
  grossPayAmount: 1_250_000,
  totalDeductionAmount: 41_250,
  netPayAmount: 1_208_750,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  storeId: 5,
  storeName: '모리커피 연남점',
  sentAt: null,
  logs: [
    {
      payslipLogId: 2,
      logType: 'SEND',
      changedAt: new Date('2026-08-10T00:30:00.000Z'),
    },
  ],
  isWithholdingApplied: true,
  items: [
    item(1, 'EARNING', 'BASE_PAY', '기본급', {
      calculatedAmount: 1_000_000,
      adjustedAmount: 1_050_000,
    }),
    item(2, 'EARNING', 'BONUS', '상여', { isEntered: false }),
    item(3, 'EARNING', 'MEAL_ALLOWANCE', '식대', {
      isTaxFree: true,
      adjustedAmount: 200_000,
    }),
    item(4, 'BASIC', 'NATIONAL_PENSION', '국민연금', { adjustedAmount: 0 }),
    item(5, 'BASIC', 'INCOME_TAX', '소득세', { adjustedAmount: 9_999 }),
    item(6, 'BASIC', 'LOCAL_INCOME_TAX', '지방소득세', { adjustedAmount: 999 }),
    item(7, 'WITHHOLDING', 'BUSINESS_INCOME_TAX', '사업소득세(3%)', {
      adjustedAmount: 37_500,
    }),
    item(8, 'WITHHOLDING', 'BUSINESS_LOCAL_INCOME_TAX', '지방소득세(0.3%)', {
      adjustedAmount: 3_750,
    }),
    item(9, 'ADDITIONAL', 'YEAR_END_SETTLEMENT', '연말(중도)정산', {
      adjustedAmount: 0,
    }),
  ],
  ...over,
});

describe('payslip PDF', () => {
  it('직원 앱 상세와 같은 칸 — 기간 · 이름 · 근무지 · 계약 유형 · 발송일(한국 날짜)', () => {
    const model = payslipPdfModel(detail(), '유하람');
    expect(model).toMatchObject({
      title: '급여명세서',
      info: [
        ['급여 기간', '2026년 7월 1일 – 7월 31일'],
        ['직원', '유하람'],
        ['근무지', '모리커피 연남점'],
        ['계약 유형', '파트타이머'],
        ['발송일', '2026년 8월 10일'],
      ],
      totals: [
        ['지급 합계', '1,250,000원'],
        ['공제 합계', '41,250원'],
      ],
      net: '1,208,750원',
    });
  });

  it('지급 줄 — 금액은 고친 값 > 계산값 > 0, 비과세 표시', () => {
    expect(payslipPdfModel(detail(), '유하람').earnings).toEqual([
      { name: '기본급', note: null, amount: '1,050,000원' },
      { name: '상여', note: null, amount: '0원' },
      { name: '식대', note: '비과세', amount: '200,000원' },
    ]);
  });

  it('공제 줄 — 3.3% 를 켜면 소득세 · 지방소득세 대신 원천징수 둘(끝자리 안내 PAY-7)', () => {
    expect(payslipPdfModel(detail(), '유하람').deductions).toEqual([
      { name: '국민연금', note: null, amount: '0원' },
      {
        name: '사업소득세(3%)',
        note: '끝자리 세무 확인 대기(PAY-7)',
        amount: '37,500원',
      },
      {
        name: '지방소득세(0.3%)',
        note: '끝자리 세무 확인 대기(PAY-7)',
        amount: '3,750원',
      },
      { name: '연말(중도)정산', note: null, amount: '0원' },
    ]);
    const off = payslipPdfModel(
      detail({ isWithholdingApplied: false }),
      '유하람',
    );
    expect(off.deductions.map((r) => r.name)).toEqual([
      '국민연금',
      '소득세',
      '지방소득세',
      '연말(중도)정산',
    ]);
  });

  it('두 번 이상 보냈으면 마지막 발송일만 — 「다시 발송」은 붙이지 않는다(PAY-20)', () => {
    const model = payslipPdfModel(
      detail({
        logs: [
          {
            payslipLogId: 3,
            logType: 'SEND',
            changedAt: new Date('2026-08-12T15:10:00.000Z'),
          },
          {
            payslipLogId: 2,
            logType: 'CANCEL_CONFIRMATION',
            changedAt: new Date('2026-08-11T00:00:00.000Z'),
          },
          {
            payslipLogId: 1,
            logType: 'SEND',
            changedAt: new Date('2026-08-10T00:30:00.000Z'),
          },
        ],
      }),
      '유하람',
    );
    // 한국 시각으로 8월 13일
    expect(model.info.at(-1)).toEqual(['발송일', '2026년 8월 13일']);
  });

  it('파일 이름 — 급여명세서_YYYY-MM_이름.pdf, ASCII 대신 이름은 payslip_YYYY-MM_id.pdf', () => {
    expect(payslipPdfFileName(detail(), '유하람')).toEqual({
      name: '급여명세서_2026-07_유하람.pdf',
      ascii: 'payslip_2026-07_40.pdf',
    });
    // 파일 이름에 쓸 수 없는 글자는 밑줄로
    expect(payslipPdfFileName(detail(), '유/하"람').name).toBe(
      '급여명세서_2026-07_유_하_람.pdf',
    );
  });

  it('Content-Disposition — ASCII 대신 이름과 UTF-8 이름(괄호 · 따옴표도 인코딩)', () => {
    expect(
      contentDisposition({
        name: "급여명세서_2026-07_유(하)'람.pdf",
        ascii: 'payslip_2026-07_40.pdf',
      }),
    ).toBe(
      `attachment; filename="payslip_2026-07_40.pdf"; filename*=UTF-8''${encodeURIComponent('급여명세서_2026-07_유')}%28${encodeURIComponent('하')}%29%27${encodeURIComponent('람.pdf')}`,
    );
  });

  it('PDF 로 그린다 — 한글 글꼴을 넣은 A4 한 장', async () => {
    const pdf = await renderPayslipPdf(payslipPdfModel(detail(), '유하람'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('Pretendard');
    expect(pdf.length).toBeLessThan(500_000);
  });

  it('금액이 없는(검토 중) 명세서는 0원 파일을 만들지 않고 멈춘다', () => {
    expect(() =>
      payslipPdfModel(
        detail({ correcting: true, netPayAmount: null }),
        '유하람',
      ),
    ).toThrow();
  });
});
