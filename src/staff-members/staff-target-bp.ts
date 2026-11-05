/** 플랫폼 계정이 BP 를 고르지 않고 직원 목록을 부름 — `targetStores` 의 400. 직원 단위 경로는 404 로 둔다(근로계약 상세와 같다) */
export const STAFF_BP_NOT_CHOSEN = '직원 정보를 볼 BP 를 골라 주세요.';
/** 직원 단위 경로의 404 Swagger 설명에 덧붙인다 — 헤더 없는 플랫폼 계정은 플랫폼 BP 에 직원이 없어 404 다 */
export const STAFF_BP_MISSING_404_DESCRIPTION =
  '플랫폼 계정의 X-Bp-Code-Id 누락(직원 단위라 400 이 아니라 404)';
