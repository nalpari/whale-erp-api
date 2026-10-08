-- 근로계약(contracts)은 키만 NOT NULL 로 둔다 (2026-10-08). 근로계약서를 다 채우지 않고 임시저장할 수 있게 한다.
-- 기본키 · 외래키(staff_member_id · store_id · created_by)는 그대로 두고, 나머지 칸의 NOT NULL 을 푼다. 기본값은 남는다.
-- 필수 칸 검사는 앱이 저장 단계마다 한다. 물리 결정은 docs/erd-physical/_model.py 의 KEYS_ONLY_NOT_NULL.
--
-- work_terms · wage_terms 는 있을 때만 푼다. 근무 조건 · 급여 조건을 컬럼으로 푸는 작업(lucario 브랜치의
-- 20261007000300_team3_contract_terms)이 이미 적용된 DB 에는 두 칸이 없다 — 그 DB 에서도, 아직 없는 DB 에서도 돈다.

ALTER TABLE "contracts" ALTER COLUMN "employment_type" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "contract_method" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "start_date" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "is_health_pension_insured" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "is_employment_injury_insured" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "resend_count" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "created_at" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "updated_at" DROP NOT NULL;

DO $$
DECLARE
    col text;
BEGIN
    FOREACH col IN ARRAY ARRAY['work_terms', 'wage_terms'] LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'contracts' AND column_name = col
        ) THEN
            EXECUTE format('ALTER TABLE "contracts" ALTER COLUMN %I DROP NOT NULL', col);
        END IF;
    END LOOP;
END $$;
