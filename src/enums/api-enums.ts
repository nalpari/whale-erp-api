import type { EnumSource } from './enums.service';

/**
 * DB 에 없는 API 전용 enum 의 한글. DB enum 은 db-enums.generated.ts(물리 ERD 원본에서 생성)에 있고,
 * 같은 이름을 여기 두면 EnumsService 가 띄울 때 막는다.
 *
 * 값은 코드에 이미 있는 상수에서 가져온다. 값 목록을 여기 따로 적으면 둘이 어긋난다.
 * 지금은 없다 — 견본 로그인의 UserType 을 지우며 비었다 (2026-10-07).
 */
export const API_ENUMS: EnumSource = {};
