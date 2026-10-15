-- 근로계약서의 급여 지급 방식 · 수습 칸과 주휴일 저장 (노무사 확인 2026-10-14, 데모 확인 2026-10-15).
-- 급여 지급 방식은 계좌 · 현금 중 하나다. 수습은 정직원이고 계약 기간이 1년 이상이거나 기간의 정함이 없을 때만 두며,
-- 기간은 1~3개월, 수습 중 임금 감액률은 0~10%(최저임금의 90% 보장)다. 두 칸은 함께 채우거나 함께 비운다.
-- 정직원 · 계약 기간 조건과 최저임금 90% 는 api 가 저장할 때 본다(근로계약은 키만 NOT NULL 이라 DB 는 값 범위만 막는다).
-- 주휴일 칸은 이미 있다. 지금까지는 저장하지 않았고(2026-10-08), 이제 관리자가 근무하지 않는 요일 하나를 고른다 — 설명만 바꾼다.
-- 물리 결정은 docs/erd-physical/_model.py.
CREATE TYPE "pay_method" AS ENUM ('ACCOUNT', 'CASH');
COMMENT ON TYPE "pay_method" IS '계좌 · 현금';

ALTER TABLE "contracts"
    ADD COLUMN "pay_method" "pay_method",
    ADD COLUMN "probation_months" INTEGER,
    ADD COLUMN "probation_wage_reduction_rate" INTEGER;

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_probation_months_range" CHECK ("probation_months" BETWEEN 1 AND 3);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_probation_wage_reduction_rate_range" CHECK ("probation_wage_reduction_rate" BETWEEN 0 AND 10);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_probation_pair" CHECK (("probation_months" IS NULL) = ("probation_wage_reduction_rate" IS NULL));

COMMENT ON COLUMN "contracts"."weekly_holiday" IS '주휴일 — 근무하지 않는 요일 하나를 관리자가 고른다. 주 소정근로시간 15시간 미만이면 NULL (노무사 확인 2026-10-14) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."pay_method" IS '급여 지급 방식 — 계좌 · 현금 — 계약서 임금 조항 (2026-10-15) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."probation_months" IS '수습 기간 — 개월, 1~3. 비우면 수습 없음 — 정직원이고 계약 기간이 1년 이상이거나 기간의 정함이 없을 때만 (노무사 확인 2026-10-14) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."probation_wage_reduction_rate" IS '수습 임금 감액률 — %, 0~10. 수습 중 시급 = 시급 × (1 − 감액률) — 최저임금의 90% 이상 (노무사 확인 2026-10-14) (물리에서 추가)';
