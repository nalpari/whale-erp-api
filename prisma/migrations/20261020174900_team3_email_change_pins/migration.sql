-- 직원 앱 이메일 아이디 변경 핀 (WHALEERP-191, 2026-10-20 노영주). 새 이메일로 핀을 보내 맞힌 뒤에만 계정 이메일을 바꾼다.
-- 바꿀 새 이메일을 핀과 함께 저장해야 해서 비밀번호 재설정 핀(password_reset_pins)과 표를 나눈다 — 섞으면 재설정 쪽 조회가
-- 모두 「새 이메일 없음」 조건을 걸어야 한다. 규칙은 재설정 핀과 같다(해시 저장 · 5회 · 1분 간격 · 하루 10회), 유효시간만
-- 템플릿 EMAIL_CHANGE_PIN 문구대로 15분이다.
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. front 논리 ERD 카탈로그에 같은 표를 넣는 것은
-- 기획 세션(재영) 몫이라 요청으로 넘겼다 — 생성기는 카탈로그 사본에 표를 넣은 것과 넣기 전의 차이만 이 저장소에 옮겼다.
CREATE TABLE "email_change_pins" (
    "email_change_pin_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "new_email" TEXT NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_change_pins_pkey" PRIMARY KEY ("email_change_pin_id")
);

ALTER TABLE "email_change_pins" ADD CONSTRAINT "email_change_pins_attempt_count_range" CHECK ("attempt_count" BETWEEN 0 AND 5);
ALTER TABLE "email_change_pins" ADD CONSTRAINT "email_change_pins_new_email_lower" CHECK ("new_email" = lower("new_email"));
ALTER TABLE "email_change_pins" ADD CONSTRAINT "email_change_pins_expires_after_issued" CHECK ("expires_at" > "issued_at");
ALTER TABLE "email_change_pins" ADD CONSTRAINT "email_change_pins_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "email_change_pins_account_id_idx" ON "email_change_pins" ("account_id");

COMMENT ON TABLE "email_change_pins" IS '이메일 변경 핀';
COMMENT ON COLUMN "email_change_pins"."email_change_pin_id" IS '핀 ID (논리 pin_id)';
COMMENT ON COLUMN "email_change_pins"."account_id" IS '계정';
COMMENT ON COLUMN "email_change_pins"."new_email" IS '새 이메일 — 핀을 보낸 주소, 소문자. 확인되면 계정 이메일이 이 값이 된다';
COMMENT ON COLUMN "email_change_pins"."pin_hash" IS '핀 검증값 — 원본 저장 안 함';
COMMENT ON COLUMN "email_change_pins"."issued_at" IS '발급 시각 — 1분 재발급 제한, 하루 10회';
COMMENT ON COLUMN "email_change_pins"."expires_at" IS '만료 시각 — 발급 시각부터 15분';
COMMENT ON COLUMN "email_change_pins"."attempt_count" IS '시도 횟수 — 5회 틀리면 그 핀은 닫힘, 새 핀을 받는다';
COMMENT ON COLUMN "email_change_pins"."used_at" IS '사용 시각 — 이메일을 바꾸면 남김. 새 핀 메일이 나가면 그보다 앞선 핀도 닫는다';
