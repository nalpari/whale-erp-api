/**
 * 상단 점포 범위의 유형 — 3팀 목록(직원 · 근로계약 · 급여명세서 · TO-DO · 출퇴근)의 `storeTypes` 쿼리가 받는 값(API enum
 * `StoreScopeType`, 2026-11-17). 공통코드 STORE_TYPE(직영 · 가맹)에 본사(HQ)를 더한 것이다. 본사 점포는 store_type_code 가
 * DIRECT 지만 범위에서는 따로 친다 — DIRECT 는 본사가 아닌 직영, HQ 는 본사. 유형을 주지 않으면 「전체」(본사 포함 — 다만
 * 가맹마스터 · 가맹관리자(FM · FA)는 전체 점포 관리여도 본사가 업무 범위에 없다). 헤더 「전체 · 직영 · 가맹 · 본사 · 점포 하나」 → 없음 · [DIRECT] · [FRANCHISE] · [HQ] · storeIds.
 */
export const STORE_SCOPE_TYPES = ['DIRECT', 'FRANCHISE', 'HQ'] as const;
export type StoreScopeType = (typeof STORE_SCOPE_TYPES)[number];

/** 범위 유형의 한글 — GET /enums 의 StoreScopeType. */
export const STORE_SCOPE_TYPE_LABELS = {
  DIRECT: '직영',
  FRANCHISE: '가맹',
  HQ: '본사',
} as const satisfies Record<StoreScopeType, string>;

/** 점포가 고른 유형 중 하나에 맞는가. 유형을 주지 않으면 늘 맞는다. isHq 를 모르는 행은 본사가 아닌 것으로 본다. */
export function matchesStoreScope(
  store: { storeTypeCode: string; isHq?: boolean },
  types: readonly string[] | null | undefined,
): boolean {
  if (!types || types.length === 0) return true;
  const isHq = store.isHq === true;
  return types.some((t) =>
    t === 'HQ'
      ? isHq
      : t === 'DIRECT'
        ? store.storeTypeCode === 'DIRECT' && !isHq
        : store.storeTypeCode === t,
  );
}

/**
 * 본사 점포를 다룰 수 있는 계정인가 — 본사도 일반 점포처럼 권한 · 매칭으로 본다(2026-11-17 사용자 결정, 처음의 「BP
 * 마스터만」을 바꿈). 플랫폼 · BP 마스터 · BP 관리자는 본사도 다른 점포와 같은 규칙(전체 점포면 포함, 아니면 매핑된
 * 것)이고, 가맹 마스터 · 가맹 관리자는 매칭 대상이 가맹 점포라 본사가 범위에 들어가지 않는다(전체 점포여도) — 업무
 * 범위 · 선택지 · 3팀 목록에서 빠지고 직접 부르면 범위 밖과 같다.
 */
export function canSeeHq(roleTypeCode: string, isPlatform: boolean): boolean {
  return isPlatform || !['FM', 'FA'].includes(roleTypeCode);
}
