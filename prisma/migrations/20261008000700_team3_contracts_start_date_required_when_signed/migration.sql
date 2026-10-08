-- 체결 완료(SIGNED) 근로계약은 계약 시작일이 있어야 한다 (2026-10-08 재영).
-- 근무스케줄 · 출퇴근은 근무일을 기간에 포함하는 체결 완료 계약이 있어야 받는다. 시작일이 없으면 기간을 판정할 수 없다.
-- 20261008000400 에서 임시저장을 위해 start_date 의 NOT NULL 을 풀었으므로, 체결 완료 행에만 다시 요구한다.
-- 물리 결정은 docs/erd-physical/_model.py 의 CHECKS.

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_start_date_required_when_signed"
    CHECK ("status" <> 'SIGNED' OR "start_date" IS NOT NULL);
