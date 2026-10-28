/**
 * 본사 제공 동의 문구 버전(운영 정책 ATT-30) — 내 정보에서 다시 동의할 때와 같은 값을 `accounts.hq_sharing_consent_version`
 * 에 남긴다. 값은 내 정보 동의(#85) 한 곳에만 둔다(api #81 재리뷰).
 */
export { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';

/** 본사 제공 동의를 묻는 점포인가 — 직영이 아니면(모르는 유형 포함) 묻는다. 가림(hidesPersonalData)과 같은 기준이다 */
export const asksHqSharingConsentAt = (storeTypeCode: string | undefined) =>
  storeTypeCode !== 'DIRECT';
