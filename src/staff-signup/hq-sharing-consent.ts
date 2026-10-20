/**
 * 본사 제공 동의 문구 버전(운영 정책 ATT-30). 직원이 가입하며 동의하면 이 값을 `accounts.hq_sharing_consent_version` 에
 * 남긴다. 문구를 고칠 때 올린다 — 받는 자 · 항목 · 목적이 넓어지면 다시 동의받기 전까지 미동의로 본다(2026-10-15 재영).
 */
export const HQ_SHARING_CONSENT_VERSION = '1';

/** 본사 제공 동의를 묻는 점포인가 — 직영이 아니면(모르는 유형 포함) 묻는다. 가림(hidesPersonalData)과 같은 기준이다 */
export const asksHqSharingConsentAt = (storeTypeCode: string | undefined) =>
  storeTypeCode !== 'DIRECT';
