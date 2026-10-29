-- 직원 자료 일괄 저장 bulk_exports · 내려받기 이력 bulk_export_download_logs (WHALEERP-336, 운영 정책 RET-09 · ATT-30 · NTF-01).
--
-- BP 마스터(BM) · 가맹마스터(FM)가 업무 범위 점포의 근로계약서 · 출퇴근 기록 · 급여명세서 · 근무스케줄을 zip 하나로 받는다.
-- 1분 배치가 대기 요청을 FOR UPDATE SKIP LOCKED 로 하나씩 집어 만들고, 완료부터 7일 동안 받는다. 기한이 지나면 매일 배치가
-- 파일을 지우고 storage_key 를 비운다. 같은 BP · 같은 범위(scope_key 의 md5)는 만드는 중인 요청이 하나뿐이다(부분 고유 인덱스).
-- 운영 알림 · 메일은 없다 — 상태는 일괄 저장 화면에서만 본다(NTF-01). 남겨야 하는 기록이라 is_deleted 를 두지 않는다.
--
-- 3팀 논리 카탈로그(front docs/erd/README.md)에 아직 없어 물리 생성기(_model.py · schema.sql)를 거치지 않고 손으로 썼다.

CREATE TYPE "bulk_export_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');  -- 대기 · 만드는 중 · 완료 · 실패
COMMENT ON TYPE "bulk_export_status" IS '대기 · 만드는 중 · 완료 · 실패';

CREATE TABLE "bulk_exports" (
    "bulk_export_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "bp_code_id" INTEGER NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "role_type_code" TEXT NOT NULL,
    "store_ids" INTEGER[] NOT NULL,
    "scope_key" TEXT NOT NULL,
    "status" "bulk_export_status" NOT NULL DEFAULT 'PENDING',
    "staff_count" INTEGER NOT NULL,
    "staff_member_ids" INTEGER[] NOT NULL DEFAULT '{}',
    "storage_key" TEXT,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "bulk_exports_pkey" PRIMARY KEY ("bulk_export_id")
);

CREATE TABLE "bulk_export_download_logs" (
    "bulk_export_download_log_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "bulk_export_id" INTEGER NOT NULL,
    "downloaded_by" INTEGER NOT NULL,
    "downloaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_export_download_logs_pkey" PRIMARY KEY ("bulk_export_download_log_id")
);

ALTER TABLE "bulk_exports" ADD CONSTRAINT "bulk_exports_role_type_code_check" CHECK ("role_type_code" IN ('BM', 'FM'));
ALTER TABLE "bulk_exports" ADD CONSTRAINT "bulk_exports_store_ids_not_empty" CHECK (cardinality("store_ids") > 0);
ALTER TABLE "bulk_exports" ADD CONSTRAINT "bulk_exports_counts_nonnegative" CHECK ("staff_count" >= 0 AND "attempt_count" >= 0 AND ("file_size" IS NULL OR "file_size" >= 0));
ALTER TABLE "bulk_exports" ADD CONSTRAINT "bulk_exports_started_when_processing" CHECK ("status" <> 'PROCESSING' OR "started_at" IS NOT NULL);
ALTER TABLE "bulk_exports" ADD CONSTRAINT "bulk_exports_completed_when_succeeded" CHECK ("status" <> 'SUCCEEDED' OR ("completed_at" IS NOT NULL AND "expires_at" IS NOT NULL));
-- 같은 BP · 같은 범위는 만드는 중인 요청이 하나뿐 — 앱이 409 로 먼저 막고 이 인덱스가 마지막 방어선이다. scope_key 는 점포 수만큼 길어져
-- (전체 점포면 수백 개) btree 한 행 한도(약 2.7KB)를 넘을 수 있어 md5 로 묶는다.
CREATE UNIQUE INDEX "bulk_exports_bp_code_id_scope_key_key" ON "bulk_exports" ("bp_code_id", md5("scope_key")) WHERE "status" IN ('PENDING', 'PROCESSING');
ALTER TABLE "bulk_exports" ADD CONSTRAINT "bulk_exports_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bulk_exports" ADD CONSTRAINT "bulk_exports_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bulk_export_download_logs" ADD CONSTRAINT "bulk_export_download_logs_bulk_export_id_fkey" FOREIGN KEY ("bulk_export_id") REFERENCES "bulk_exports" ("bulk_export_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bulk_export_download_logs" ADD CONSTRAINT "bulk_export_download_logs_downloaded_by_fkey" FOREIGN KEY ("downloaded_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "bulk_exports_bp_code_id_role_type_code_requested_at_idx" ON "bulk_exports" ("bp_code_id", "role_type_code", "requested_at");
CREATE INDEX "bulk_exports_status_requested_at_idx" ON "bulk_exports" ("status", "requested_at");
CREATE INDEX "bulk_export_download_logs_bulk_export_id_idx" ON "bulk_export_download_logs" ("bulk_export_id");

COMMENT ON TABLE "bulk_exports" IS '직원 자료 일괄 저장 요청';
COMMENT ON COLUMN "bulk_exports"."bulk_export_id" IS '일괄 저장 요청 ID';
COMMENT ON COLUMN "bulk_exports"."bp_code_id" IS '요청 BP — bp_codes FK';
COMMENT ON COLUMN "bulk_exports"."requested_by" IS '요청한 관리자 — admin_accounts FK';
COMMENT ON COLUMN "bulk_exports"."role_type_code" IS '요청 때 권한 유형 — BM · FM. 목록 · 내려받기는 같은 BP · 같은 권한 유형이고 store_ids 를 모두 관리하는 마스터만 (2026-10-29 재영)';
COMMENT ON COLUMN "bulk_exports"."store_ids" IS '업무 범위 점포 — 오름차순. 비면 안 된다';
COMMENT ON COLUMN "bulk_exports"."scope_key" IS '범위 키 — {role_type_code}:{store_ids}. 만드는 중인 요청이 (bp_code_id, md5(scope_key)) 마다 하나뿐';
COMMENT ON COLUMN "bulk_exports"."status" IS '처리 상태 — 대기 · 만드는 중 · 완료 · 실패';
COMMENT ON COLUMN "bulk_exports"."staff_count" IS '담은 직원 수 — 요청 때 센 수, 다 만들면 실제로 담은 수';
COMMENT ON COLUMN "bulk_exports"."staff_member_ids" IS '파일에 담은 직원 레코드 ID — 다 만들 때 채운다. BP 마스터 파일은 내려받기 직전에 이 직원들의 본사 제공 동의 · 가맹 점포 폐점을 다시 보고 바뀌었으면 막는다 (2026-10-29 재영, RET-09)';
COMMENT ON COLUMN "bulk_exports"."storage_key" IS '저장소 키 — bulk-exports/{bp_code_id}/{uuid}.zip. 기한이 지나 파일을 지우면 NULL';
COMMENT ON COLUMN "bulk_exports"."file_name" IS '파일명 — 직원자료_{BP명}_{YYYYMMDD}.zip (요청한 한국 날짜)';
COMMENT ON COLUMN "bulk_exports"."file_size" IS '파일 크기 — 바이트';
COMMENT ON COLUMN "bulk_exports"."attempt_count" IS '시도 횟수 — 시도를 시작할 때 1씩 올린다(최대 2). 2에서 실패하거나 4xx 성격(권한 · 범위)이면 끝';
COMMENT ON COLUMN "bulk_exports"."failure_reason" IS '실패 사유';
COMMENT ON COLUMN "bulk_exports"."requested_at" IS '요청 일시';
COMMENT ON COLUMN "bulk_exports"."started_at" IS '만들기 시작 일시 — 이번 시도를 시작한 시각. 멈춘 작업 판단 기준';
COMMENT ON COLUMN "bulk_exports"."completed_at" IS '완료 일시';
COMMENT ON COLUMN "bulk_exports"."expires_at" IS '받을 수 있는 기한 — 완료 + 7일';
COMMENT ON TABLE "bulk_export_download_logs" IS '직원 자료 일괄 저장 내려받기 이력';
COMMENT ON COLUMN "bulk_export_download_logs"."bulk_export_download_log_id" IS '내려받기 이력 ID';
COMMENT ON COLUMN "bulk_export_download_logs"."bulk_export_id" IS '일괄 저장 요청 — bulk_exports FK';
COMMENT ON COLUMN "bulk_export_download_logs"."downloaded_by" IS '내려받은 관리자 — admin_accounts FK';
COMMENT ON COLUMN "bulk_export_download_logs"."downloaded_at" IS '내려받은 일시 — 내려받기 주소를 준 시각';
