import { currentStaffTerms, staffTermsAgreementRows } from './staff-terms';

const NOW = new Date('2026-11-27T01:00:00.000Z');

describe('currentStaffTerms', () => {
  const ALL_TYPES = ['STAFF_TERMS_SERVICE', 'STAFF_PRIVACY', 'MARKETING'];
  const db = (rows: unknown[], activeTypes: string[] = ALL_TYPES) => ({
    termsVersion: { findMany: jest.fn().mockResolvedValue(rows) },
    codeItem: {
      findMany: jest
        .fn()
        .mockResolvedValue(activeTypes.map((itemCode) => ({ itemCode }))),
    },
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

  it('약관 유형은 플랫폼 공통코드 TERMS_TYPE 에서 쓰는 것만 — 공개 약관 API 와 같은 기준(api #326 code-review)', async () => {
    const d = db([]);
    await currentStaffTerms(d);
    expect(d.codeItem.findMany).toHaveBeenCalledWith({
      where: {
        groupCode: 'TERMS_TYPE',
        bpCode: 'BP000000',
        isDeleted: false,
        status: 'ACTIVE',
        codeGroup: { isDeleted: false, status: 'ACTIVE' },
      },
      select: { itemCode: true },
    });
  });

  it('공통코드에서 마케팅을 끄면 마케팅 null — 화면도 그 약관을 404 로 받아 보이지 않는다', async () => {
    await expect(
      currentStaffTerms(
        db(
          [
            row('STAFF_TERMS_SERVICE', 3),
            row('STAFF_PRIVACY', 4),
            row('MARKETING', 5),
          ],
          ['STAFF_TERMS_SERVICE', 'STAFF_PRIVACY'],
        ),
      ),
    ).resolves.toMatchObject({ marketing: null });
  });

  it('공통코드에서 필수 약관을 끄면 null — 시행 중인 필수 약관이 없는 것과 같다', async () => {
    await expect(
      currentStaffTerms(
        db(
          [
            row('STAFF_TERMS_SERVICE', 3),
            row('STAFF_PRIVACY', 4),
            row('MARKETING', 5),
          ],
          ['STAFF_PRIVACY', 'MARKETING'],
        ),
      ),
    ).resolves.toBeNull();
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

  it('필수 약관 하나라도 시행 중인 버전이 없으면 null — 운영자가 끄거나 지웠다', async () => {
    await expect(
      currentStaffTerms(
        db([row('STAFF_TERMS_SERVICE', 3), row('MARKETING', 5)]),
      ),
    ).resolves.toBeNull();
  });

  it('선택 약관(마케팅)만 없으면 마케팅 null — 막지 않는다', async () => {
    await expect(
      currentStaffTerms(
        db([row('STAFF_TERMS_SERVICE', 3), row('STAFF_PRIVACY', 4)]),
      ),
    ).resolves.toEqual({
      termsService: { termsVersionId: 3, version: 'v1.0' },
      privacy: { termsVersionId: 4, version: 'v1.0' },
      marketing: null,
    });
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

  it('시행 중인 마케팅 약관이 없으면 필수 두 줄만', () => {
    expect(
      staffTermsAgreementRows({
        accountId: 77,
        terms: { ...terms, marketing: null },
        marketingAgreed: true,
        channel: 'SIGNUP',
        agreedAt: NOW,
      }).map((r) => r.termsVersionId),
    ).toEqual([3, 4]);
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
