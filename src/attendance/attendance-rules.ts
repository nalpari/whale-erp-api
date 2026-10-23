import type { AttendanceReviewReason } from '@prisma/client';

/**
 * 근무지 반경(미터). 운영 정책은 「전체 공통 100m 가 기본이고 지하 · 실내 점포는 관리자가 더 넓게 고친다」(ATT-2 ·
 * WHALEERP-210)인데, 점포(1팀 `stores`)에 반경 칸이 아직 없다 — ERD 에도 「1팀 점포 테이블에 넣을지 정해야 한다」로 남아
 * 있다. 그래서 1차는 모든 점포에 100m 를 내려준다(2026-10-22 효준). 점포별로 넓히려면 반경 칸(물리 ERD 의 제안 이름
 * `stores.geofence_radius_m`)과 점포 관리 화면 · API 가 함께 정해져야 한다 — 그때 이 상수를 그 칸의 기본값으로 바꾼다.
 */
export const DEFAULT_GEOFENCE_RADIUS_M = 100;

/** 위치정보 확인자료의 수집 방법(ATT-22) — 좌표는 휴대전화 밖으로 나오지 않는다(ATT-05) */
export const LOCATION_ACCESS_METHOD = '기기 GPS · 휴대전화 안 판정';

/**
 * 앱이 붙여 보낼 수 있는 확인 필요 사유. 출근은 반경 밖만 — 위치 조작 감지면 앱이 출근을 막는다(ATT-21). 퇴근은 반경 밖
 * · 위치 조작 감지 둘 다 받는다. 위치 오차 초과는 더 쓰지 않는다(ATT-4 · ATT-11, 2026-10-20 재영).
 */
export const CHECK_IN_REVIEW_REASONS = [
  'OUT_OF_RADIUS_CHECKIN',
] as const satisfies readonly AttendanceReviewReason[];
export const CHECK_OUT_REVIEW_REASONS = [
  'OUT_OF_RADIUS_CHECKOUT',
  'MOCK_LOCATION',
] as const satisfies readonly AttendanceReviewReason[];
