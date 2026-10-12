-- 근로계약 근무 조건 · 급여 조건을 JSON 에서 꺼낸다 (2026-10-07, 3팀 확인 필요).
--
--   contracts.work_terms (jsonb)  → contract_work_days — 요일마다 한 행(시업 · 종업 · 휴게 시작 · 휴게 종료)
--   contracts.wage_terms (jsonb)  → contracts.wage_amount · pay_month · pay_day
--
-- 급여액의 뜻은 고용 형태가 정한다 — 정직원은 월급, 파트타이머는 시급(목업 contracts-new). 그래서 급여 형태 컬럼은 두지 않는다.
-- 초기 마이그레이션(20261007000000_team3_initial)은 적용돼 고칠 수 없어서 차이를 여기 손으로 쓴다.
-- 이 파일까지 적용한 결과가 docs/raw/2026-10-06-3팀-schema.sql 과 같아야 한다(_model.LATER_MIGRATIONS).
--
-- 두 JSON 의 모양이 정해진 적이 없어 옮길 방법이 없다. 계약이 한 건이라도 있으면 여기서 멈춘다.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "contracts") THEN
        RAISE EXCEPTION 'contracts 에 행이 있다 — work_terms · wage_terms 를 새 컬럼으로 옮기는 방법을 먼저 정한다';
    END IF;
END $$;

CREATE TYPE "pay_month" AS ENUM ('CURRENT_MONTH', 'NEXT_MONTH');  -- 당월 · 익월

ALTER TABLE "contracts" DROP COLUMN "work_terms";
ALTER TABLE "contracts" DROP COLUMN "wage_terms";
ALTER TABLE "contracts" ADD COLUMN "wage_amount" INTEGER NOT NULL;
ALTER TABLE "contracts" ADD COLUMN "pay_month" "pay_month" NOT NULL;
ALTER TABLE "contracts" ADD COLUMN "pay_day" INTEGER NOT NULL;

CREATE TABLE "contract_work_days" (
    "contract_id" INTEGER NOT NULL,
    "weekday" "weekday" NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME NOT NULL,
    "break_start_time" TIME,
    "break_end_time" TIME,

    CONSTRAINT "contract_work_days_pkey" PRIMARY KEY ("contract_id", "weekday")
);

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_wage_amount_positive" CHECK ("wage_amount" > 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_pay_day_range" CHECK ("pay_day" BETWEEN 1 AND 31);
ALTER TABLE "contract_work_days" ADD CONSTRAINT "contract_work_days_end_after_start" CHECK ("end_time" > "start_time");
ALTER TABLE "contract_work_days" ADD CONSTRAINT "contract_work_days_break_pair" CHECK (("break_start_time" IS NULL) = ("break_end_time" IS NULL));
ALTER TABLE "contract_work_days" ADD CONSTRAINT "contract_work_days_break_within_work" CHECK ("break_start_time" IS NULL OR ("break_start_time" >= "start_time" AND "break_end_time" > "break_start_time" AND "break_end_time" <= "end_time"));
ALTER TABLE "contract_work_days" ADD CONSTRAINT "contract_work_days_half_hour_unit" CHECK (EXTRACT(EPOCH FROM "start_time")::integer % 1800 = 0 AND EXTRACT(EPOCH FROM "end_time")::integer % 1800 = 0 AND ("break_start_time" IS NULL OR (EXTRACT(EPOCH FROM "break_start_time")::integer % 1800 = 0 AND EXTRACT(EPOCH FROM "break_end_time")::integer % 1800 = 0)));
ALTER TABLE "contract_work_days" ADD CONSTRAINT "contract_work_days_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON COLUMN "contracts"."wage_amount" IS '급여액 — 정직원은 월급, 파트타이머는 시급';
COMMENT ON COLUMN "contracts"."pay_month" IS '임금지급 월 — 당월·익월';
COMMENT ON COLUMN "contracts"."pay_day" IS '임금지급일 — 1~31, 31은 말일';
COMMENT ON TABLE "contract_work_days" IS '계약 근무 요일';
COMMENT ON COLUMN "contract_work_days"."contract_id" IS '근로계약';
COMMENT ON COLUMN "contract_work_days"."weekday" IS '요일 — 근무하는 요일만 행으로 둔다';
COMMENT ON COLUMN "contract_work_days"."start_time" IS '시업 시각 — 30분 단위';
COMMENT ON COLUMN "contract_work_days"."end_time" IS '종업 시각 — 시업보다 뒤, 같은 날 안';
COMMENT ON COLUMN "contract_work_days"."break_start_time" IS '휴게 시작 — 휴게가 없으면 비움';
COMMENT ON COLUMN "contract_work_days"."break_end_time" IS '휴게 종료';
