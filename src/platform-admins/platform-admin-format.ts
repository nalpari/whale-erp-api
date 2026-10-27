/** PostgreSQL integer 의 최댓값. 넘는 값은 DB 가 거부해 400 이 아니라 500 이 되므로 검증에서 막는다. */
export const INT4_MAX = 2_147_483_647;

/** 이 메뉴가 다루고, 이 메뉴를 쓸 수 있는 권한 유형 — 플랫폼 마스터 · 플랫폼 관리자. */
export const PLATFORM_ROLE_TYPES = ['PM', 'PA'];

/**
 * 아이디 — 영문 또는 영문 · 숫자 4~20자. DB CHECK(`admin_accounts_login_id_format`)는
 * 숫자만으로 된 값도 받지만 화면 규칙(PL-OCJOFP)은 영문을 하나 이상 요구한다.
 */
export const LOGIN_ID_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{4,20}$/;

/**
 * 연락처 — 하이픈 없이 숫자 9~12자리(02 지역번호 9자리 · 050X 평생번호 12자리 포함). 점포 연락처와 같은
 * 범위이고, DB CHECK `admin_accounts_phone_format` 과 같다.
 */
export const PHONE_PATTERN = /^[0-9]{9,12}$/;

/** 이름 — 한글 · 영문 2~20자. DB 는 길이만 CHECK 한다. */
export const NAME_PATTERN = /^[가-힣A-Za-z ]{2,20}$/;

/** 앞뒤 공백을 지워 받는다 — 공백만 있으면 빈 값이 되어 길이 · 형식 검사가 거른다. */
export const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 이메일은 소문자로 저장한다(CHECK `admin_accounts_email_lower`). */
export const lowerEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** 선택 칸은 빈 문자열을 NULL 로 — 지운 값과 빈 값을 같은 것으로 저장한다. */
export const emptyToNull = ({ value }: { value: unknown }): unknown => {
  const trimmed = trimText({ value });
  return trimmed === '' ? null : trimmed;
};
