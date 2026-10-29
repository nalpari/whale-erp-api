/** 새 메뉴에 권한 행을 함께 넣는 고정 권한 — 플랫폼 마스터. 권한 판정은 저장된 행을 읽기 때문이다. */
export const PLATFORM_MASTER_ROLE_CODE = 'PM000001';

/** 노출 메뉴명 길이(2026-10-16 결정). DB 는 길이를 CHECK 하지 않는다. */
export const MENU_NAME_MAX = 20;

/** 메뉴 URL 의 모양 — '/' 로 시작하는 소문자 · 숫자 · '-' 구간들. DTO 가 건다(시드의 여러 구간 URL 도 이 모양이다). */
export const MENU_URL_PATTERN = /^(\/[a-z0-9-]+)+$/;
/**
 * 새로 넣는 URL 은 1뎁스 한 구간만(예: /staff/content 가 아니라 /staff-content, 2026-10-19). 등록과, 수정에서 URL 을
 * 바꿀 때만 서비스가 건다 — 시드의 여러 구간 URL 은 실제 화면 주소라, 그대로 둔 채 이름 · 상태를 고칠 수 있어야 한다
 * (1팀 메뉴 URL · 라우트를 1뎁스로 옮기기 전까지).
 */
export const MENU_URL_ONE_SEGMENT = /^\/[a-z0-9-]+$/;
export const MENU_URL_ONE_SEGMENT_MESSAGE =
  "메뉴 URL 은 '/' 하나로 시작하는 1뎁스 경로만 됩니다 — 소문자 · 숫자 · '-' 로, 구간은 '-' 로 잇습니다(예: /staff-content)";
export const MENU_URL_MAX = 200;

export const NOT_FOUND = '메뉴를 찾을 수 없습니다.';
export const SERVICE_NOT_FOUND = '서비스를 찾을 수 없습니다.';
export const CHANGED_MEANWHILE =
  '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요.';
