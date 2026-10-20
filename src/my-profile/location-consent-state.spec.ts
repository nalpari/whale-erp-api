import {
  LOCATION_CONSENT_STATE_LABELS,
  locationConsentOf,
} from './location-consent-state';

const at = (iso: string) => new Date(iso);
const row = (patch: Record<string, unknown> = {}) => ({
  locationConsentId: 1,
  consentVersion: 'v1.0',
  agreedAt: at('2026-10-01T00:00:00Z'),
  pausedAt: null as Date | null,
  withdrawnAt: null as Date | null,
  ...patch,
});

describe('locationConsentOf', () => {
  it('기록이 없으면 미동의, 나머지는 null', () => {
    expect(locationConsentOf([])).toEqual({
      state: 'NOT_AGREED',
      consentVersion: null,
      agreedAt: null,
      pausedAt: null,
      withdrawnAt: null,
    });
  });

  it('철회도 일시 중지도 없으면 동의', () => {
    expect(locationConsentOf([row()])).toEqual({
      state: 'AGREED',
      consentVersion: 'v1.0',
      agreedAt: at('2026-10-01T00:00:00Z'),
      pausedAt: null,
      withdrawnAt: null,
    });
  });

  it('일시 중지 시각이 있으면 일시 중지 (ATT-26)', () => {
    const pausedAt = at('2026-10-05T00:00:00Z');
    expect(locationConsentOf([row({ pausedAt })])).toMatchObject({
      state: 'PAUSED',
      pausedAt,
    });
  });

  it('철회가 일시 중지보다 앞선다 — 일시 중지 뒤 철회했으면 pausedAt 은 null', () => {
    const withdrawnAt = at('2026-10-06T00:00:00Z');
    expect(
      locationConsentOf([
        row({ pausedAt: at('2026-10-05T00:00:00Z'), withdrawnAt }),
      ]),
    ).toEqual({
      state: 'WITHDRAWN',
      consentVersion: 'v1.0',
      agreedAt: at('2026-10-01T00:00:00Z'),
      pausedAt: null,
      withdrawnAt,
    });
  });

  it('모두 철회했으면 id 가 아니라 동의 시각이 가장 늦은 기록', () => {
    const withdrawnAt = at('2026-10-20T00:00:00Z');
    expect(
      locationConsentOf([
        row({
          locationConsentId: 9,
          consentVersion: 'v-early',
          agreedAt: at('2026-10-01T00:00:00Z'),
          withdrawnAt,
        }),
        row({
          locationConsentId: 3,
          consentVersion: 'v-late',
          agreedAt: at('2026-10-08T00:00:00Z'),
          withdrawnAt,
        }),
      ]).consentVersion,
    ).toBe('v-late');
  });

  it('여러 행이면 가장 늦게 동의한 것 — 철회 뒤 다시 동의했으면 동의', () => {
    expect(
      locationConsentOf([
        row({
          locationConsentId: 1,
          withdrawnAt: at('2026-10-03T00:00:00Z'),
        }),
        row({
          locationConsentId: 2,
          consentVersion: 'v1.1',
          agreedAt: at('2026-10-04T00:00:00Z'),
        }),
      ]),
    ).toMatchObject({ state: 'AGREED', consentVersion: 'v1.1' });
  });

  it('철회하지 않은 기록이 있으면 그것 — 동의 시각이 더 늦은 철회 기록보다 앞선다', () => {
    expect(
      locationConsentOf([
        row({ locationConsentId: 5, consentVersion: 'v1.1' }),
        row({
          locationConsentId: 6,
          agreedAt: at('2026-10-09T00:00:00Z'),
          withdrawnAt: at('2026-10-10T00:00:00Z'),
        }),
      ]),
    ).toMatchObject({ state: 'AGREED', consentVersion: 'v1.1' });
  });

  it('모두 철회했고 동의 시각이 같으면 id 가 큰 것', () => {
    const withdrawnAt = at('2026-10-05T00:00:00Z');
    expect(
      locationConsentOf([
        row({ locationConsentId: 3, consentVersion: 'v3', withdrawnAt }),
        row({ locationConsentId: 9, consentVersion: 'v9', withdrawnAt }),
      ]).consentVersion,
    ).toBe('v9');
  });

  it('한글 표기는 4종, 화면 선택지 순서', () => {
    expect(Object.keys(LOCATION_CONSENT_STATE_LABELS)).toEqual([
      'NOT_AGREED',
      'AGREED',
      'PAUSED',
      'WITHDRAWN',
    ]);
  });
});
