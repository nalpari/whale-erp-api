import type { EnumSource } from './enums.service';
import { STAFF_JOIN_STATE_LABELS } from '../staff-members/join-state';

/**
 * DB 에 없는 API 전용 enum 의 한글. DB enum 은 db-enums.generated.ts(enum 타입 설명에서 생성)에 있고,
 * 같은 이름을 여기 두면 EnumsService 가 띄울 때 막는다.
 *
 * 값은 코드에 이미 있는 상수에서 가져온다. 값 목록을 여기 따로 적으면 둘이 어긋난다.
 */
export const API_ENUMS: EnumSource = {
  /** 직원 목록의 가입·인증 상태 (WHALEERP-329) */
  StaffJoinState: Object.entries(STAFF_JOIN_STATE_LABELS),
};
