-- 출퇴근 확인 필요 사유에 「근무 12시간 초과」를 더한다(운영 정책, 2026-10-27 재영 — 긴 짝은 길이 상한을 두지 않고, 출근부터 퇴근까지
-- 12시간이 넘으면 퇴근 기록에 이 사유를 붙인다). 관리자는 보정하거나 「이상 없음」으로 검토를 마치고, 급여명세서의 「확인 필요 기록
-- 포함」에도 그대로 걸린다.
ALTER TYPE "attendance_review_reason" ADD VALUE 'LONG_SHIFT';
COMMENT ON TYPE "attendance_review_reason" IS '위치 오차 초과 · 반경 밖 출근 · 반경 밖 퇴근 · 위치 조작 감지 · 근무 12시간 초과';
COMMENT ON COLUMN "attendance_records"."review_reason" IS '확인 필요 사유 — 반경 밖 출근·반경 밖 퇴근·위치 조작·근무 12시간 초과, 검토 후 null';
