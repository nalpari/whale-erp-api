import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';
import { hqSharingConsentRecordOf } from './hq-sharing-consent';

describe('hqSharingConsentRecordOf — 가입 · 수락에서 본사 제공 동의를 남길지(ATT-30 v252 · v253)', () => {
  it.each([
    [
      '묻지 않음(직영 · 이미 받아 주는 버전)',
      false,
      {
        hqSharingConsented: true,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
      },
      null,
    ],
    ['동의하지 않음', true, { hqSharingConsented: false }, null],
    ['동의 칸 없음', true, {}, null],
    [
      '지금 버전에 동의',
      true,
      {
        hqSharingConsented: true,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
      },
      true,
    ],
    [
      '다른 버전에 동의',
      true,
      { hqSharingConsented: true, hqSharingConsentVersion: 'v0.9' },
      false,
    ],
    // 버전을 싣지 않는 예전 앱 — 400 이 아니라 가입 · 수락은 마치고 동의만 남기지 않는다(앱이 다시 동의를 안내하게 false)
    ['버전 없이 동의', true, { hqSharingConsented: true }, false],
  ] as const)('%s → %s', (_, asked, dto, expected) => {
    expect(hqSharingConsentRecordOf(asked, dto)).toBe(expected);
  });
});
