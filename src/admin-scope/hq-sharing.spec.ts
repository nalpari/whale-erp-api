import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from './hq-sharing';

describe('본사 제공 동의 (계정에 하나, 2026-10-20)', () => {
  it('직원 레코드의 계정에서 읽는다', () => {
    expect(HQ_SHARING_SELECT).toEqual({
      account: { select: { isHqSharingConsented: true } },
    });
    expect(HQ_SHARING_CONSENTED).toEqual({
      account: { is: { isHqSharingConsented: true } },
    });
  });

  it('계정의 값을 그대로', () => {
    expect(
      hqSharingConsentedOf({ account: { isHqSharingConsented: true } }),
    ).toBe(true);
    expect(
      hqSharingConsentedOf({ account: { isHqSharingConsented: false } }),
    ).toBe(false);
  });

  it('가입 전(계정 없음)이면 동의하지 않은 것 — 가린다', () => {
    expect(hqSharingConsentedOf({ account: null })).toBe(false);
  });
});
