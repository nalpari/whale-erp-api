import type { AttendanceReviewReason } from '@prisma/client';
import { addMonths, kstDayStart, kstToday } from '../staff-members/kst-date';

/** 근무지 반경(미터) — 1차는 모든 점포 100m 고정이고 점포별로 넓히는 기능은 두지 않는다(운영 정책 ATT-02, 2026-10-23 재영) */
export const DEFAULT_GEOFENCE_RADIUS_M = 100;

/** 보정 · 대신 등록할 수 있는 기간 — 최근 3개월(ATT-20 · WHALEERP-218) */
export const EDITABLE_MONTHS = 3;

/**
 * 보정할 수 있는 가장 이른 순간(한국 그날 0시). 이보다 오래 열린 출근은 보정으로 닫을 수 없어 출근 · 대신 등록을 막지 않는다 — 막으면
 * 그 계정의 앱 출근이 영영 막힌다(PR #159 리뷰). 그 출근은 관리자 화면에 퇴근 미등록으로 남는다.
 */
export const editableStart = () =>
  kstDayStart(addMonths(kstToday(), -EDITABLE_MONTHS));

/**
 * 긴 짝 — 출근부터 퇴근까지 이보다 길면 퇴근 기록에 확인 필요 사유 「근무 12시간 초과」(LONG_SHIFT)를 붙인다. 길이 상한은 두지 않는다
 * (2026-10-27 재영). 관리자는 보정하거나 「이상 없음」으로 검토를 마친다.
 */
export const LONG_SHIFT_MS = 12 * 60 * 60_000;

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
