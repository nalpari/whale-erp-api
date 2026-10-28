/** 본사 제공 동의를 묻는 점포인가 — 직영이 아니면(모르는 유형 포함) 묻는다. 가림(hidesPersonalData)과 같은 기준이다 */
export const asksHqSharingConsentAt = (storeTypeCode: string | undefined) =>
  storeTypeCode !== 'DIRECT';
