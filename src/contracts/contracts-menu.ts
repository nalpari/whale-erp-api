/**
 * 근로계약 관리 메뉴 — 컨트롤러 경로(/contracts)가 메뉴 url 이다(경로 방식 @MenuPermission, menu-permission-urls 표).
 * 근로계약 서비스와 직원 목록 · 상세(workDays 노출 판정, WHALEERP-622 후속)가 같이 쓴다.
 */
export const CONTRACTS_MENU = { url: '/contracts' } as const;
