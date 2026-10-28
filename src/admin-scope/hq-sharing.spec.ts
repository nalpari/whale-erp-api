import { HQ_SHARING_CONSENT_VERSION } from '../my-profile/my-consent.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  HQ_SHARING_VALID_VERSIONS,
  hqSharingConsentedOf,
  needsHqSharingReconsent,
} from './hq-sharing';

const agreed = (hqSharingConsentVersion: string | null) => ({
  isHqSharingConsented: true,
  hqSharingConsentVersion,
});

describe('본사 제공 동의 (계정에 하나, 2026-10-20)', () => {
  it('직원 레코드의 계정에서 읽는다 — 동의와 문구 버전', () => {
    expect(HQ_SHARING_SELECT).toEqual({
      account: {
        select: { isHqSharingConsented: true, hqSharingConsentVersion: true },
      },
    });
    expect(HQ_SHARING_CONSENTED).toEqual({
      account: {
        is: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: { in: [...HQ_SHARING_VALID_VERSIONS] },
        },
      },
    });
  });

  it('새로 받는 버전은 늘 받아 주는 버전에 있다', () => {
    expect(HQ_SHARING_VALID_VERSIONS).toContain(HQ_SHARING_CONSENT_VERSION);
  });

  it('받아 주는 버전에 동의했으면 동의', () => {
    expect(
      hqSharingConsentedOf({ account: agreed(HQ_SHARING_CONSENT_VERSION) }),
    ).toBe(true);
    expect(
      hqSharingConsentedOf({
        account: {
          isHqSharingConsented: false,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        },
      }),
    ).toBe(false);
  });

  it('더는 받아 주지 않는 버전(항목 · 목적이 넓어짐)에 동의했으면 미동의로 보고 다시 묻는다', () => {
    const old = agreed('v0.9');
    expect(hqSharingConsentedOf({ account: old })).toBe(false);
    expect(needsHqSharingReconsent(old)).toBe(true);
    expect(needsHqSharingReconsent(agreed(HQ_SHARING_CONSENT_VERSION))).toBe(
      false,
    );
  });

  it('미동의 · 철회는 다시 묻는 대상이 아니다 — 어차피 새로 묻는다', () => {
    expect(
      needsHqSharingReconsent({
        isHqSharingConsented: false,
        hqSharingConsentVersion: 'v0.9',
      }),
    ).toBe(false);
    expect(
      needsHqSharingReconsent({
        isHqSharingConsented: false,
        hqSharingConsentVersion: null,
      }),
    ).toBe(false);
  });

  it('가입 전(계정 없음)이면 동의하지 않은 것 — 가린다', () => {
    expect(hqSharingConsentedOf({ account: null })).toBe(false);
  });
});
