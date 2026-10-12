-- 근로계약서 임금 · 근로시간 조항과 연차휴가 · 퇴직금 조항(2026-10-12).
-- 비과세 수당(식대 · 자가운전보조금 · 육아수당)은 원 단위 정수, 근로시간은 월 단위 시간을 소수 한 자리로 둔다(30분 단위).
-- 연차휴가 · 퇴직금 조항은 작성 화면이 기본 문구를 채우고 관리자가 고친다. 기본값은 DB 가 아니라 화면이 둔다.
-- 근로계약은 키만 NOT NULL 이라 모두 NULL 을 허용한다.
ALTER TABLE "contracts"
    ADD COLUMN "meal_allowance_amount" INTEGER,
    ADD COLUMN "car_allowance_amount" INTEGER,
    ADD COLUMN "childcare_allowance_amount" INTEGER,
    ADD COLUMN "base_hours" NUMERIC(5,1),
    ADD COLUMN "monthly_overtime_hours" NUMERIC(5,1),
    ADD COLUMN "base_night_hours" NUMERIC(5,1),
    ADD COLUMN "base_holiday_hours" NUMERIC(5,1),
    ADD COLUMN "monthly_extra_holiday_hours" NUMERIC(5,1),
    ADD COLUMN "annual_leave_terms" TEXT,
    ADD COLUMN "severance_pay_terms" TEXT;

-- 비과세 수당 · 월 근로시간은 0 이상.
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_meal_allowance_amount_nonnegative" CHECK ("meal_allowance_amount" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_car_allowance_amount_nonnegative" CHECK ("car_allowance_amount" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_childcare_allowance_amount_nonnegative" CHECK ("childcare_allowance_amount" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_base_hours_nonnegative" CHECK ("base_hours" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_monthly_overtime_hours_nonnegative" CHECK ("monthly_overtime_hours" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_base_night_hours_nonnegative" CHECK ("base_night_hours" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_base_holiday_hours_nonnegative" CHECK ("base_holiday_hours" >= 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_monthly_extra_holiday_hours_nonnegative" CHECK ("monthly_extra_holiday_hours" >= 0);

-- 급여액은 고용 형태와 상관없이 시급만 둔다(2026-10-12). 월급은 근로시간으로 셈한다.
COMMENT ON COLUMN "contracts"."wage_amount" IS '급여액 — 시급 — 고용 형태와 상관없이 시급만 둔다. 월급은 근로시간으로 셈한다 (2026-10-12)';

COMMENT ON COLUMN "contracts"."meal_allowance_amount" IS '식대 — 원. 비과세 수당 — 계약서 임금 조항 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."car_allowance_amount" IS '자가운전보조금 — 원. 비과세 수당 — 계약서 임금 조항 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."childcare_allowance_amount" IS '육아수당 — 원. 비과세 수당 — 계약서 임금 조항 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."base_hours" IS '기본시간 — 월 소정근로시간 — 월 단위 시간, 소수 한 자리 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."monthly_overtime_hours" IS '월간 연장근무 — 기본시간 밖 연장근로 — 월 단위 시간, 소수 한 자리 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."base_night_hours" IS '기본시간 중 야간근무 — 기본시간에 든 야간근로(22~06시) — 월 단위 시간, 소수 한 자리 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."base_holiday_hours" IS '기본시간 중 휴일근무 — 기본시간에 든 휴일근로 — 월 단위 시간, 소수 한 자리 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."monthly_extra_holiday_hours" IS '월간 추가 휴일근무 — 기본시간 밖 휴일근로 — 월 단위 시간, 소수 한 자리 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."annual_leave_terms" IS '연차휴가 조항 — 계약서 연차휴가 조항. 작성 화면이 기본 문구를 채우고 관리자가 고친다 (2026-10-12) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."severance_pay_terms" IS '퇴직금 조항 — 계약서 퇴직금 조항. 작성 화면이 기본 문구를 채우고 관리자가 고친다 (2026-10-12) (물리에서 추가)';
