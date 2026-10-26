import type { AttendanceReviewReason } from '@prisma/client';

/** 근무지 반경(미터) — 1차는 모든 점포 100m 고정이고 점포별로 넓히는 기능은 두지 않는다(운영 정책 ATT-02, 2026-10-23 재영) */
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
