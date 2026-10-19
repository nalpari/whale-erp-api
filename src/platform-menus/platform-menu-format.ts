/** 메뉴 「플랫폼 메뉴 관리」(/platform/system/menus) */
export const PLATFORM_MENU_MENU = 'MN000215';

/** 새 메뉴에 권한 행을 함께 넣는 고정 권한 — 플랫폼 마스터. 권한 판정은 저장된 행을 읽기 때문이다. */
export const PLATFORM_MASTER_ROLE_CODE = 'PM000001';

/** 노출 메뉴명 길이(2026-10-16 결정). DB 는 길이를 CHECK 하지 않는다. */
export const MENU_NAME_MAX = 20;

/**
 * 메뉴 URL — 1뎁스 한 구간만: '/' 하나로 시작하는 소문자 · 숫자 · '-'(예: /staff/content 가 아니라 /staff-content, 2026-10-19).
 * 등록 · 수정 모두 건다. 시드의 여러 구간 URL 은 그대로 남지만, 그 메뉴를 저장하려면 1뎁스로 고쳐야 한다.
 */
export const MENU_URL_PATTERN = /^\/[a-z0-9-]+$/;
export const MENU_URL_MAX = 200;

export const NOT_FOUND = '메뉴를 찾을 수 없습니다';
export const SERVICE_NOT_FOUND = '서비스를 찾을 수 없습니다';
export const CHANGED_MEANWHILE =
  '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요';
