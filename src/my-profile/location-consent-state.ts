/**
 * 내 정보의 위치정보 동의 상태(API 전용 enum). DB 칸이 아니라 계정의 동의 기록(location_consents)에서 만든다.
 * 이 순서가 화면 선택지 순서다.
 */
export const LOCATION_CONSENT_STATE_LABELS = {
  NOT_AGREED: '미동의',
  AGREED: '동의',
  PAUSED: '일시 중지',
  WITHDRAWN: '철회',
} as const;

export type LocationConsentState = keyof typeof LOCATION_CONSENT_STATE_LABELS;

export interface LocationConsentRow {
  locationConsentId: number;
  consentVersion: string;
  agreedAt: Date;
  pausedAt: Date | null;
  withdrawnAt: Date | null;
}

export interface LocationConsentView {
  state: LocationConsentState;
  consentVersion: string | null;
  agreedAt: Date | null;
  pausedAt: Date | null;
  withdrawnAt: Date | null;
}

/**
 * 철회하지 않은 기록이 있으면 그것이다 — 계정마다 하나뿐이다(부분 고유 `location_consents_account_id_key
 * WHERE withdrawn_at IS NULL`). 모두 철회했으면 가장 늦게 동의한 기록(같은 시각이면 id 가 큰 것)이다. 철회 뒤 다시
 * 동의하면 새 행이 생긴다. 철회가 일시 중지보다 앞선다(ATT-23 · ATT-26). 기록이 없으면 미동의다.
 */
export function locationConsentOf(
  rows: readonly LocationConsentRow[],
): LocationConsentView {
  let latest: LocationConsentRow | null =
    rows.find((r) => !r.withdrawnAt) ?? null;
  if (!latest)
    for (const r of rows)
      if (
        !latest ||
        r.agreedAt.getTime() > latest.agreedAt.getTime() ||
        (r.agreedAt.getTime() === latest.agreedAt.getTime() &&
          r.locationConsentId > latest.locationConsentId)
      )
        latest = r;
  if (!latest)
    return {
      state: 'NOT_AGREED',
      consentVersion: null,
      agreedAt: null,
      pausedAt: null,
      withdrawnAt: null,
    };
  const { consentVersion, agreedAt, pausedAt, withdrawnAt } = latest;
  const state: LocationConsentState = withdrawnAt
    ? 'WITHDRAWN'
    : pausedAt
      ? 'PAUSED'
      : 'AGREED';
  // 일시 중지 뒤 철회한 행에도 pausedAt 이 남아 있다 — 일시 중지 상태일 때만 싣는다.
  return {
    state,
    consentVersion,
    agreedAt,
    pausedAt: state === 'PAUSED' ? pausedAt : null,
    withdrawnAt,
  };
}

/**
 * 동의한 약관 버전이 지금 시행 중인 것과 달라 다음 출퇴근 등록 전에 다시 받아야 하는지(ATT-23). 살아 있는 동의(동의 ·
 * 일시 중지)만 본다 — 미동의 · 철회는 어차피 새로 받는다. 시행 중인 약관이 없으면(운영자가 모두 끔) 다시 받을 버전이 없어
 * false 다.
 */
export function needsLocationReconsent(
  view: Pick<LocationConsentView, 'state' | 'consentVersion'>,
  currentVersion: string | null,
): boolean {
  return (
    (view.state === 'AGREED' || view.state === 'PAUSED') &&
    currentVersion !== null &&
    view.consentVersion !== currentVersion
  );
}
