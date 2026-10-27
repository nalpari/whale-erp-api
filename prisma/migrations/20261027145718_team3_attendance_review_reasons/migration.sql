-- 출퇴근 확인 필요 사유에 「반경 밖 출근」, 급여명세서 검토 대기 사유에 「확인 필요 기록 포함」을 더한다
-- (WHALEERP-209, 쟁점 ATT-11 · 2026-10-20 재영, 운영 정책 ATT-14 · ATT-19).
-- 반경 밖에서도 출근을 받고 확인 필요로 기록한다. 확인 필요 출근 · 퇴근도 급여 계산에 그대로 넣는 대신, 그 기록이 든 명세서에는
-- 검토 대기 사유를 붙인다. 위치 오차 초과(ACCURACY_EXCEEDED)는 더 쓰지 않지만 값은 남긴다 — 운영 데이터가 없고 PostgreSQL 은
-- enum 값을 지우려면 타입을 다시 만들어야 해서다(쟁점 ATT-4, 2026-10-20 재영).
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. 출근 값은 퇴근 앞에 둔다(물리 모델의 값 순서와 같게).
ALTER TYPE "attendance_review_reason" ADD VALUE 'OUT_OF_RADIUS_CHECKIN' BEFORE 'OUT_OF_RADIUS_CHECKOUT';
COMMENT ON TYPE "attendance_review_reason" IS '위치 오차 초과 · 반경 밖 출근 · 반경 밖 퇴근 · 위치 조작 감지';

ALTER TYPE "payslip_review_reason" ADD VALUE 'ATTENDANCE_NEEDS_REVIEW';
COMMENT ON TYPE "payslip_review_reason" IS '출퇴근 누락 · 계약 만료 후 기록 · 기간 중 계약 변경 · 공제 미입력 · 확인 필요 기록 포함';

-- 근무지는 자동으로 고르지 않고 직원이 고른다(운영 정책 ATT-07, 2026-10-20 재영)
COMMENT ON COLUMN "attendance_records"."store_id" IS '근무지 — 여럿이면 직원이 고른 곳';
COMMENT ON COLUMN "attendance_records"."review_reason" IS '확인 필요 사유 — 반경 밖 출근·반경 밖 퇴근·위치 조작, 검토 후 null';
COMMENT ON COLUMN "payslip_review_reasons"."review_reason" IS '사유 — 출퇴근 누락·계약 만료 후 기록·기간 중 계약 변경·공제 미입력·확인 필요 기록 포함 (논리 reason)';
