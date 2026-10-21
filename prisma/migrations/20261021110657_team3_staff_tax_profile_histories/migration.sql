-- 신고 정보 변경 이력 staff_tax_profile_histories (WHALEERP-334, 논리 ERD front #69 · 2026-10-20 재영).
--
-- 직원이 신고 정보를 처음 내거나 고칠 때 무엇을(주민등록번호 · 급여 계좌) 언제 누가 바꿨는지 항목마다 한 행 남긴다. 값(이전 · 새
-- 값)은 어느 칸에도 남기지 않는다. 신고 정보가 직원 레코드(점포 소속)마다 하나라 이력도 레코드 기준이다.

-- CreateEnum
CREATE TYPE "staff_tax_profile_field" AS ENUM ('RRN', 'PAYROLL_ACCOUNT');  -- 주민등록번호 · 급여 계좌
COMMENT ON TYPE "staff_tax_profile_field" IS '주민등록번호 · 급여 계좌';

-- CreateTable
CREATE TABLE "staff_tax_profile_histories" (
    "staff_tax_profile_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "field" "staff_tax_profile_field" NOT NULL,
    "account_id" INTEGER NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_tax_profile_histories_pkey" PRIMARY KEY ("staff_tax_profile_history_id")
);

-- AddForeignKey
ALTER TABLE "staff_tax_profile_histories" ADD CONSTRAINT "staff_tax_profile_histories_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_tax_profile_histories" ADD CONSTRAINT "staff_tax_profile_histories_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- CreateIndex
CREATE INDEX "staff_tax_profile_histories_staff_member_id_changed_at_idx" ON "staff_tax_profile_histories" ("staff_member_id", "changed_at");

COMMENT ON TABLE "staff_tax_profile_histories" IS '신고 정보 변경 이력';
COMMENT ON COLUMN "staff_tax_profile_histories"."staff_tax_profile_history_id" IS '이력 ID';
COMMENT ON COLUMN "staff_tax_profile_histories"."staff_member_id" IS '직원 레코드 — 신고 정보는 레코드마다 하나라 이력도 레코드 기준';
COMMENT ON COLUMN "staff_tax_profile_histories"."field" IS '바뀐 항목 — 주민등록번호 · 급여 계좌(은행·계좌번호 함께)';
COMMENT ON COLUMN "staff_tax_profile_histories"."account_id" IS '바꾼 계정 — 직원 본인만 고친다 (TAX-07)';
COMMENT ON COLUMN "staff_tax_profile_histories"."changed_at" IS '바꾼 시각 — (staff_member_id, changed_at) 인덱스 · 값(이전·새 값)은 남기지 않음 · 처음 작성도 항목마다 한 행 (#334, 2026-10-20)';
