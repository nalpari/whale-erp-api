import { currentStaffTerms, staffTermsAgreementRows } from './staff-terms';

const NOW = new Date('2026-11-27T01:00:00.000Z');

describe('currentStaffTerms', () => {
  const db = (rows: unknown[]) => ({
    termsVersion: { findMany: jest.fn().mockResolvedValue(rows) },
  });
  const row = (
    termsTypeCode: string,
    termsVersionId: number,
    version = 'v1.0',
  ) => ({
    termsTypeCode,
    termsVersionId,
    version,
  });

  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it('직원 앱 약관 셋을 한 번에 읽는다 — 시행일이 한국 오늘까지인 사용 중 버전, 늦게 시행한 것부터', async () => {
    const d = db([]);
    await currentStaffTerms(d);
    expect(d.termsVersion.findMany).toHaveBeenCalledWith({
      where: {
        termsTypeCode: {
          in: ['STAFF_TERMS_SERVICE', 'STAFF_PRIVACY', 'MARKETING'],
        },
        isActive: true,
        isDeleted: false,
        effectiveDate: { lte: new Date('2026-11-27T00:00:00.000Z') },
      },
      orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
      select: { termsTypeCode: true, termsVersionId: true, version: true },
    });
  });

  it('유형마다 맨 앞(지금 시행 중) 것을 고른다', async () => {
    await expect(
      currentStaffTerms(
        db([
          row('MARKETING', 9, 'v1.1'),
          row('STAFF_TERMS_SERVICE', 3, 'v1.2'),
          row('MARKETING', 5),
          row('STAFF_PRIVACY', 4),
          row('STAFF_TERMS_SERVICE', 1),
        ]),
      ),
    ).resolves.toEqual({
      termsService: { termsVersionId: 3, version: 'v1.2' },
      privacy: { termsVersionId: 4, version: 'v1.0' },
      marketing: { termsVersionId: 9, version: 'v1.1' },
    });
  });

  it('하나라도 시행 중인 버전이 없으면 null — 운영자가 끄거나 지웠다', async () => {
    await expect(
      currentStaffTerms(
        db([row('STAFF_TERMS_SERVICE', 3), row('STAFF_PRIVACY', 4)]),
      ),
    ).resolves.toBeNull();
  });
});

describe('staffTermsAgreementRows', () => {
  const terms = {
    termsService: { termsVersionId: 3, version: 'v1.0' },
    privacy: { termsVersionId: 4, version: 'v1.0' },
    marketing: { termsVersionId: 5, version: 'v1.0' },
  };

  it('필수 둘은 동의, 마케팅은 고른 대로 — 세 줄 모두 같은 시각 · 경로 · IP', () => {
    expect(
      staffTermsAgreementRows({
        accountId: 77,
        terms,
        marketingAgreed: false,
        channel: 'SIGNUP',
        agreedAt: NOW,
        clientAddress: '203.0.113.7',
      }),
    ).toEqual(
      [3, 4, 5].map((termsVersionId) => ({
        accountId: 77,
        termsVersionId,
        isAgreed: termsVersionId !== 5,
        agreedAt: NOW,
        channel: 'SIGNUP',
        clientAddress: '203.0.113.7',
      })),
    );
  });

  it('IP 를 모르면 null', () => {
    const rows = staffTermsAgreementRows({
      accountId: 77,
      terms,
      marketingAgreed: true,
      channel: 'FIRST_LOGIN',
      agreedAt: NOW,
    });
    expect(rows.map((r) => [r.isAgreed, r.clientAddress])).toEqual([
      [true, null],
      [true, null],
      [true, null],
    ]);
  });
});
