-- 근로계약은 키만 NOT NULL (20261008000200_team3_contracts_keys_only_not_null) — 그 뒤 근무 조건 · 급여 조건을
-- 컬럼으로 푼 칸(20261007000300_team3_contract_terms)도 같게 맞춘다. 임시저장한 근로계약서는 급여를 비울 수 있다.
ALTER TABLE "contracts" ALTER COLUMN "wage_amount" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "pay_month" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "pay_day" DROP NOT NULL;
