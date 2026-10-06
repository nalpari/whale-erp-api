import { USER_TYPE_VALUES } from '../auth/auth.types';
import type { EnumSource } from './enums.service';

/**
 * DB 에 없는 API 전용 enum 의 한글. DB enum 은 db-enums.generated.ts(물리 ERD 원본에서 생성)에 있고,
 * 같은 이름을 여기 두면 EnumsService 가 띄울 때 막는다.
 *
 * 값은 코드에 이미 있는 상수에서 가져온다. 값 목록을 여기 따로 적으면 둘이 어긋난다.
 */
const USER_TYPE_LABEL: Record<(typeof USER_TYPE_VALUES)[number], string> = {
  staff: '직원',
  customer: '관리자 웹 사용자', // customers 는 관리자 웹 로그인 주체다. 용어집은 「관리자」 단독을 역할명으로 쓰지 않는다
};

export const API_ENUMS: EnumSource = {
  UserType: USER_TYPE_VALUES.map((v) => [v, USER_TYPE_LABEL[v]] as const),
};
