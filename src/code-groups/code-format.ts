/**
 * 그룹 코드 · 상세 코드 형식 — 영문 대문자·숫자·밑줄, 영문으로 시작, 20자 이내.
 * DB CHECK(`code_groups_group_code_format` · `code_items_item_code_format`)와 같은 식이다.
 */
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,19}$/;

/** 플랫폼 원본 행이 쓰는 BP — 플랫폼 BP 는 BP000000 하나다. */
export const PLATFORM_BP_CODE = 'BP000000';

/** 이 화면이 다루는 관리 주체. BP전용(BP_ONLY)은 BP 공통코드 관리의 몫이다. */
export const PLATFORM_OWNER_CODES = [
  'PLATFORM_FIXED',
  'PLATFORM_PROVIDED',
] as const;
export type PlatformOwnerCode = (typeof PLATFORM_OWNER_CODES)[number];

export const BP_ONLY_OWNER_CODE = 'BP_ONLY';

/** 등록 · 수정 한 요청의 행 수 상한 — 화면이 한 번에 보낼 만큼. 그룹은 200, 상세 코드는 500. */
export const MAX_GROUP_ROWS = 200;
export const MAX_ITEM_ROWS = 500;

/**
 * 여러 행을 한 행씩 고치는 수정 트랜잭션의 시간 제한. 최대 200 · 500행이라 원격 DB 에서는 Prisma 기본 5초를 넘길 수
 * 있고, 넘기면 원인을 알 수 없는 500 이 된다.
 */
export const BULK_UPDATE_TX = { timeout: 30_000, maxWait: 5_000 };

/** PostgreSQL integer 의 최댓값. 넘는 값은 DB 가 거부해 400 이 아니라 500 이 되므로 검증에서 막는다. */
export const INT4_MAX = 2_147_483_647;

/** 이름 · 코드명은 앞뒤 공백을 지워 받는다 — 공백만 있으면 빈 값이 되어 길이 검사가 거른다. */
export const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 앞뒤 공백을 지우고 대문자로 바꿔 받는다(정책). 문자열이 아니면 그대로 두어 형식 검사가 거른다. */
export const toUpperCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
