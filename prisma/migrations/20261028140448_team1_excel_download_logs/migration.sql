-- 엑셀 다운로드 이력 excel_download_logs (2026-10-28, 사용자 결정). 모든 화면의 엑셀 요청 한 건이 한 행이다.
--
-- 1만 건 미만은 바로 받고(DIRECT), 이상은 예약 생성(SCHEDULED) — 배치가 파일을 만들어 S3 excel-exports/ 에 24시간 두고
-- 등록한 이메일로 내려받기 링크를 보낸다(요청한 본인만). 같은 사람 · 같은 화면은 생성 중이면 새 요청을 받지 않고
-- (부분 고유 인덱스) 1분에 한 번이다. 생성이 실패하면 한 번 다시 시도하고 실패 메일을 보낸다. 2년 보존 뒤 파기 배치가 지운다.
--
-- DDL 은 1팀 ERD 생성기(front docs/erd/team1/_build_physical.py)가 쓴 docs/raw/2026-10-12-1팀-schema.sql 의 같은 줄이다.
-- 메일 템플릿 2건(EMAIL_EXCEL_READY · EMAIL_EXCEL_FAILED)을 기본 템플릿으로 더한다 — 42건 → 44건(메일 25 → 27).

CREATE TYPE "excel_delivery_method" AS ENUM ('DIRECT', 'SCHEDULED');  -- 바로 받기 · 예약 생성
CREATE TYPE "excel_download_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');  -- 대기 · 생성 중 · 완료 · 실패

COMMENT ON TYPE "excel_delivery_method" IS '바로 받기 · 예약 생성';
COMMENT ON TYPE "excel_download_status" IS '대기 · 생성 중 · 완료 · 실패';

CREATE TABLE "excel_download_logs" (
    "excel_download_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "menu_id" INTEGER NOT NULL,
    "bp_code_id" INTEGER,
    "search_conditions" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "row_count" INTEGER NOT NULL,
    "delivery_method" "excel_delivery_method" NOT NULL,
    "status" "excel_download_status" NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "notified_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "downloaded_at" TIMESTAMPTZ(6),
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "excel_download_logs_pkey" PRIMARY KEY ("excel_download_id")
);

ALTER TABLE "excel_download_logs" ADD CONSTRAINT "excel_download_logs_counts_nonnegative" CHECK ("row_count" >= 0 AND "attempt_count" >= 0);
ALTER TABLE "excel_download_logs" ADD CONSTRAINT "excel_download_logs_scheduled_file_when_succeeded" CHECK ("delivery_method" <> 'SCHEDULED' OR "status" <> 'SUCCEEDED' OR ("storage_key" IS NOT NULL AND "expires_at" IS NOT NULL));
CREATE UNIQUE INDEX "excel_download_logs_requested_by_menu_id_key" ON "excel_download_logs" ("requested_by", "menu_id") WHERE "status" IN ('PENDING', 'PROCESSING');  -- 같은 사람 · 같은 화면은 생성 중인 예약이 하나뿐 — 새 요청은 이 인덱스로 막는다
ALTER TABLE "excel_download_logs" ADD CONSTRAINT "excel_download_logs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "excel_download_logs" ADD CONSTRAINT "excel_download_logs_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menus" ("menu_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "excel_download_logs" ADD CONSTRAINT "excel_download_logs_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "excel_download_logs_requested_by_menu_id_requested_at_idx" ON "excel_download_logs" ("requested_by", "menu_id", "requested_at");
CREATE INDEX "excel_download_logs_status_requested_at_idx" ON "excel_download_logs" ("status", "requested_at");
COMMENT ON TABLE "excel_download_logs" IS '엑셀 다운로드 이력';
COMMENT ON COLUMN "excel_download_logs"."excel_download_id" IS '다운로드 이력 ID';
COMMENT ON COLUMN "excel_download_logs"."requested_by" IS '요청자 — admin_accounts FK';
COMMENT ON COLUMN "excel_download_logs"."menu_id" IS '화면(메뉴) — menus FK — 같은 화면 판단 기준';
COMMENT ON COLUMN "excel_download_logs"."bp_code_id" IS '대상 BP — 플랫폼 계정이 고른 탭 BP, 없으면 비움';
COMMENT ON COLUMN "excel_download_logs"."search_conditions" IS '검색 조건 — 요청 때의 조건 그대로';
COMMENT ON COLUMN "excel_download_logs"."row_count" IS '건수';
COMMENT ON COLUMN "excel_download_logs"."delivery_method" IS '생성 방식 — 바로 받기·예약 생성';
COMMENT ON COLUMN "excel_download_logs"."status" IS '처리 상태 — 대기·생성 중·완료·실패';
COMMENT ON COLUMN "excel_download_logs"."file_name" IS '파일명 — 예) 점포목록_20261028.xlsx';
COMMENT ON COLUMN "excel_download_logs"."storage_key" IS '저장소 키 — 예약 생성만, excel-exports/ 아래';
COMMENT ON COLUMN "excel_download_logs"."attempt_count" IS '시도 횟수 — 시도를 시작할 때 1씩 올린다(최대 2 — 처음 1번 + 재시도 1번). 2에서 실패하면 끝';
COMMENT ON COLUMN "excel_download_logs"."failure_reason" IS '실패 사유';
COMMENT ON COLUMN "excel_download_logs"."notified_at" IS '메일 발송 일시 — 완료·실패 메일';
COMMENT ON COLUMN "excel_download_logs"."expires_at" IS '만료 일시 — 완료 + 24시간';
COMMENT ON COLUMN "excel_download_logs"."downloaded_at" IS '최근 내려받은 일시 — 링크로 받은 시각';
COMMENT ON COLUMN "excel_download_logs"."requested_at" IS '요청 일시 — 2년 보존';
COMMENT ON COLUMN "excel_download_logs"."started_at" IS '생성 시작 일시 — 이번 시도를 시작한 시각. 멈춘 작업 판단 기준';
COMMENT ON COLUMN "excel_download_logs"."completed_at" IS '완료 일시';

-- 완료 · 실패 메일. 버튼은 메일 공통 틀이 「링크」 변수로 붙인다(isButtonLink). 기본 문구로 되돌리기 원본도 같은 값이다.
INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables", "kakao_template_code", "is_active",
   "default_title", "default_body", "default_variables")
SELECT v."template_code", 'EMAIL', v."template_name", NULL, v."title", v."body", v."variables", NULL, true,
       v."title", v."body", v."variables"
FROM (VALUES
  ('EMAIL_EXCEL_READY', '엑셀 파일 준비 완료', '[WHALE ERP] 요청하신 엑셀 파일이 준비됐습니다', '요청하신 #{화면} 엑셀 파일(#{건수}건)이 준비됐습니다.

아래 버튼으로 내려받아 주세요. 링크는 #{만료일시}까지 요청하신 본인만 쓸 수 있습니다.', '[{"name": "화면", "label": "엑셀을 받은 화면", "isRequired": true, "sampleValue": "점포 목록"}, {"name": "건수", "label": "담긴 건수", "isRequired": true, "sampleValue": "12,480"}, {"name": "만료일시", "label": "내려받기 기한", "isRequired": true, "sampleValue": "2026-10-29 14:05"}, {"name": "링크", "label": "내려받기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb),
  ('EMAIL_EXCEL_FAILED', '엑셀 파일 생성 실패', '[WHALE ERP] 엑셀 파일을 만들지 못했습니다', '#{요청일시}에 요청하신 #{화면} 엑셀 파일을 만들지 못했습니다.

관리자 웹에서 다시 요청해 주세요.', '[{"name": "화면", "label": "엑셀을 요청한 화면", "isRequired": true, "sampleValue": "점포 목록"}, {"name": "요청일시", "label": "요청 일시", "isRequired": true, "sampleValue": "2026-10-28 14:01"}]'::jsonb)
) AS v("template_code", "template_name", "title", "body", "variables");

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('EMAIL_EXCEL_READY', 'EMAIL_EXCEL_FAILED') AND "channel" = 'EMAIL' AND "is_active"
     AND "default_body" IS NOT NULL;
  IF n <> 2 THEN
    RAISE EXCEPTION '엑셀 메일 기본 템플릿이 2건이 아니다: %', n;
  END IF;
  SELECT count(*) INTO n FROM pg_indexes
   WHERE tablename = 'excel_download_logs' AND indexname = 'excel_download_logs_requested_by_menu_id_key';
  IF n <> 1 THEN
    RAISE EXCEPTION '생성 중 하나만 받는 부분 고유 인덱스가 없다';
  END IF;
END $$;
