-- 3팀 직원 퇴직 처리 (2026-10-07 재영, 운영 정책 CTR-24 · CTR-25) — 3팀 DDL(20261007000000) 이후 첫 스키마 변경.
--
-- 1) 퇴직 처리 이력 staff_member_retirement_logs: 처리(RETIRE) · 취소(CANCEL) 사건 기록. 처리 행은 앞당긴 체결 완료 계약마다
--    한 줄(contract_id · previous_contract_end_date, 같은 처리는 processed_at 이 같다). 앞당긴 계약이 없으면 contract_id 가
--    빈 행 하나. 취소는 마지막 처리 묶음을 읽어 계약 종료일을 되돌린다.
-- 2) todo_status_histories.unassigned_staff_member_id: 퇴직으로 개인 배정을 풀 때 남긴다. todo_assignees 행은 DELETE 한다
--    (TO-DO 의 부속 관계라 삭제 표시를 두지 않는다 — 재영 결정).
--
-- 본문은 docs/raw/2026-10-06-3팀-schema.sql(물리 생성기 출력)에서 바뀐 줄을 그대로 옮긴 것이다. 이 마이그레이션까지 차례로
-- 적용한 DB 와 새 schema.sql 을 곧바로 적용한 DB 를 PGlite 에서 대조해 같음을 확인한다(칸 순서만 다르다 — ADD COLUMN 은 끝에 붙는다).

CREATE TYPE "retirement_action" AS ENUM ('RETIRE', 'CANCEL');  -- 처리 · 취소

-- 퇴직 처리 이력
CREATE TABLE "staff_member_retirement_logs" (
    "staff_member_retirement_log_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "action" "retirement_action" NOT NULL,
    "retired_date" DATE NOT NULL,
    "contract_id" INTEGER,
    "previous_contract_end_date" DATE,
    "processed_by" INTEGER NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_member_retirement_logs_pkey" PRIMARY KEY ("staff_member_retirement_log_id")
);

ALTER TABLE "todo_status_histories" ADD COLUMN "unassigned_staff_member_id" INTEGER;

ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_contract_only_on_retire" CHECK ("action" = 'RETIRE' OR ("contract_id" IS NULL AND "previous_contract_end_date" IS NULL));
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_end_date_needs_contract" CHECK ("previous_contract_end_date" IS NULL OR "contract_id" IS NOT NULL);

ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todo_status_histories" ADD CONSTRAINT "todo_status_histories_unassigned_staff_member_id_fkey" FOREIGN KEY ("unassigned_staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "staff_member_retirement_logs_staff_member_id_processed_at_idx" ON "staff_member_retirement_logs" ("staff_member_id", "processed_at");

COMMENT ON TABLE "staff_member_retirement_logs" IS '퇴직 처리 이력';
COMMENT ON COLUMN "staff_member_retirement_logs"."staff_member_retirement_log_id" IS '퇴직 처리 이력 ID';
COMMENT ON COLUMN "staff_member_retirement_logs"."staff_member_id" IS '직원 레코드';
COMMENT ON COLUMN "staff_member_retirement_logs"."action" IS '처리 종류 — 처리·취소';
COMMENT ON COLUMN "staff_member_retirement_logs"."retired_date" IS '퇴직일 — 처리·취소한 퇴직일';
COMMENT ON COLUMN "staff_member_retirement_logs"."contract_id" IS '앞당긴 근로계약 — 처리 행만, 계약마다 한 줄';
COMMENT ON COLUMN "staff_member_retirement_logs"."previous_contract_end_date" IS '원래 계약 종료일 — 취소 때 되돌림';
COMMENT ON COLUMN "staff_member_retirement_logs"."processed_by" IS '처리 관리자';
COMMENT ON COLUMN "staff_member_retirement_logs"."processed_at" IS '처리 일시 — 같은 처리는 같은 시각';
COMMENT ON COLUMN "todo_status_histories"."unassigned_staff_member_id" IS '배정 해제 직원 — 퇴직으로 배정을 풀었을 때 (2026-10-07)';
