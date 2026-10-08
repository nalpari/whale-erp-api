-- 3팀 알림톡 발송 이력 (2026-10-08) — 알림톡을 보낼 때마다(비즈뿌리오 접수 · 실패) 한 행.
--
-- 메일은 1팀 mail_send_logs 에 남는다. 알림톡은 notification_deliveries 에 담을 수 없다 — 그 표는 notification_recipients
-- 행에 묶여 있어, 가입 초대처럼 계정이 없는 사람에게 가는 알림톡을 담지 못한다. 그래서 받는 사람을 숫자만 남긴 번호와
-- 관련 업무(related_type · related_id, 외래키 없는 다형 참조)로 둔다. 본문은 호출부가 지정한 변수를 ******** 로 가린 것이다.
-- 지우지 않는 기록이라 is_deleted 가 없다. 논리 ERD 는 front docs/erd/_build.py(알림 장).
--
-- 본문은 docs/raw/2026-10-06-3팀-schema.sql(물리 생성기 출력)에서 바뀐 줄을 그대로 옮긴 것이다. 이 마이그레이션까지 차례로
-- 적용한 DB 와 1팀 DDL + 새 schema.sql 을 곧바로 적용한 DB 를 PGlite 에서 대조해 같음을 확인한다.

-- 알림톡 발송 이력
CREATE TABLE "alimtalk_send_logs" (
    "alimtalk_send_log_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "template_code" TEXT NOT NULL,
    "kakao_template_code" TEXT NOT NULL,
    "to_phone" TEXT NOT NULL,
    "related_type" TEXT,
    "related_id" INTEGER,
    "body" TEXT NOT NULL,
    "result" "dispatch_result" NOT NULL,
    "failure_reason" TEXT,
    "reference_key" TEXT NOT NULL,
    "message_key" TEXT,
    "sent_by" INTEGER,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alimtalk_send_logs_pkey" PRIMARY KEY ("alimtalk_send_log_id")
);

ALTER TABLE "alimtalk_send_logs" ADD CONSTRAINT "alimtalk_send_logs_to_phone_format" CHECK ("to_phone" ~ '^01[0-9]{8,9}$');
ALTER TABLE "alimtalk_send_logs" ADD CONSTRAINT "alimtalk_send_logs_related_pair" CHECK (num_nonnulls("related_type", "related_id") <> 1);

ALTER TABLE "alimtalk_send_logs" ADD CONSTRAINT "alimtalk_send_logs_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "alimtalk_send_logs_related_type_related_id_idx" ON "alimtalk_send_logs" ("related_type", "related_id");
CREATE INDEX "alimtalk_send_logs_to_phone_sent_at_idx" ON "alimtalk_send_logs" ("to_phone", "sent_at");
CREATE INDEX "alimtalk_send_logs_message_key_idx" ON "alimtalk_send_logs" ("message_key");

CREATE UNIQUE INDEX "alimtalk_send_logs_reference_key_key" ON "alimtalk_send_logs" ("reference_key");  -- 결과 리포트의 REFKEY 로 이력 한 행을 찾는다 (PR #6 팀 리뷰)

COMMENT ON TABLE "alimtalk_send_logs" IS '알림톡 발송 이력';
COMMENT ON COLUMN "alimtalk_send_logs"."alimtalk_send_log_id" IS '알림톡 발송 이력 ID';
COMMENT ON COLUMN "alimtalk_send_logs"."template_code" IS '템플릿 코드 — 보낸 알림 템플릿';
COMMENT ON COLUMN "alimtalk_send_logs"."kakao_template_code" IS '카카오 템플릿 코드 — 보낸 시점 값. 템플릿은 고쳐질 수 있음';
COMMENT ON COLUMN "alimtalk_send_logs"."to_phone" IS '수신 번호 — 숫자만, 01X 휴대폰';
COMMENT ON COLUMN "alimtalk_send_logs"."related_type" IS '관련 업무 유형 — 선택. 예: 초대';
COMMENT ON COLUMN "alimtalk_send_logs"."related_id" IS '관련 업무 ID — 선택. 유형과 함께만';
COMMENT ON COLUMN "alimtalk_send_logs"."body" IS '보낸 본문 — 호출부가 지정한 값은 ********';
COMMENT ON COLUMN "alimtalk_send_logs"."result" IS '발송 결과 — 성공·실패 (비즈뿌리오 접수 기준)';
COMMENT ON COLUMN "alimtalk_send_logs"."failure_reason" IS '실패 사유 — 비즈뿌리오 코드·HTTP 상태·메시지';
COMMENT ON COLUMN "alimtalk_send_logs"."reference_key" IS '요청 키 — 결과 리포트의 REFKEY';
COMMENT ON COLUMN "alimtalk_send_logs"."message_key" IS '메시지 키 — 비즈뿌리오가 붙인 키';
COMMENT ON COLUMN "alimtalk_send_logs"."sent_by" IS '발송 관리자 — 관리자가 대신 보냈을 때';
COMMENT ON COLUMN "alimtalk_send_logs"."sent_at" IS '발송 시각';
