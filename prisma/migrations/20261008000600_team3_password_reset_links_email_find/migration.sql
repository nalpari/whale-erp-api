-- 3팀 비밀번호 재설정 링크 · 이메일 찾기 시도 (2026-10-08 재영 승인, 노영주 요청 · Plane #172 · #178 · #584 ·
-- 운영 정책 ACC-19 · CTR-24 · 25 v91).
--
-- password_reset_links: 관리자 초기화로 보내는 재설정 링크. 토큰은 sha256 해시만 두고(고유), 발급 + 24시간에 만료한다.
-- 쓰였을 때와 새 링크로 대체됐을 때 모두 closed_at 한 칸에 닫힌 시각을 남기고 사유 칸은 두지 않는다.
-- email_find_attempts: 이메일 찾기 시도. 휴대전화번호는 HMAC 키(phone_key)로만 두고 실패 횟수 · 잠금 해제 시각을 센다.
-- 퇴직 처리 이력은 계약을 앞당기지 않으므로 contract_id · previous_contract_end_date 설명을 「퇴직일에 걸친 계약」·「처리 시점
-- 계약 종료일(참고)」로 고친다. 칸은 그대로 둔다.
--
-- 본문은 docs/raw/2026-10-06-3팀-schema.sql(물리 생성기 출력)에서 바뀐 줄을 그대로 옮긴 것이다.

CREATE TABLE "password_reset_links" (
    "password_reset_link_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "requested_by" INTEGER NOT NULL,
    CONSTRAINT "password_reset_links_pkey" PRIMARY KEY ("password_reset_link_id")
);
CREATE TABLE "email_find_attempts" (
    "email_find_attempt_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "phone_key" TEXT NOT NULL,
    "is_succeeded" BOOLEAN NOT NULL DEFAULT false,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "lock_expires_at" TIMESTAMPTZ(6),
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_find_attempts_pkey" PRIMARY KEY ("email_find_attempt_id")
);
ALTER TABLE "password_reset_links" ADD CONSTRAINT "password_reset_links_token_hash_format" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "password_reset_links" ADD CONSTRAINT "password_reset_links_expires_after_issued" CHECK ("expires_at" > "issued_at");
ALTER TABLE "email_find_attempts" ADD CONSTRAINT "email_find_attempts_failed_count_nonnegative" CHECK ("failed_count" >= 0);
CREATE UNIQUE INDEX "password_reset_links_token_hash_key" ON "password_reset_links" ("token_hash");  -- 링크는 토큰 해시로 찾는다
ALTER TABLE "password_reset_links" ADD CONSTRAINT "password_reset_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "password_reset_links" ADD CONSTRAINT "password_reset_links_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "password_reset_links_account_id_idx" ON "password_reset_links" ("account_id");
CREATE INDEX "email_find_attempts_phone_key_attempted_at_idx" ON "email_find_attempts" ("phone_key", "attempted_at");
COMMENT ON TABLE "password_reset_links" IS '비밀번호 재설정 링크';
COMMENT ON COLUMN "password_reset_links"."password_reset_link_id" IS '재설정 링크 ID';
COMMENT ON COLUMN "password_reset_links"."account_id" IS '계정';
COMMENT ON COLUMN "password_reset_links"."token_hash" IS '토큰 해시 — sha256, 원본 저장 안 함, 고유';
COMMENT ON COLUMN "password_reset_links"."issued_at" IS '발급 시각';
COMMENT ON COLUMN "password_reset_links"."expires_at" IS '만료 시각 — 발급 + 24시간';
COMMENT ON COLUMN "password_reset_links"."closed_at" IS '닫힌 시각 — 사용·새 링크로 대체 모두, 사유 칸 없음';
COMMENT ON COLUMN "password_reset_links"."requested_by" IS '요청 관리자 — 관리자 초기화 (2026-10-08)';
COMMENT ON TABLE "email_find_attempts" IS '이메일 찾기 시도';
COMMENT ON COLUMN "email_find_attempts"."email_find_attempt_id" IS '시도 ID';
COMMENT ON COLUMN "email_find_attempts"."phone_key" IS '휴대전화번호 키 — HMAC, 원본 저장 안 함';
COMMENT ON COLUMN "email_find_attempts"."is_succeeded" IS '성공 여부';
COMMENT ON COLUMN "email_find_attempts"."failed_count" IS '실패 횟수';
COMMENT ON COLUMN "email_find_attempts"."lock_expires_at" IS '잠금 해제 시각';
COMMENT ON COLUMN "email_find_attempts"."attempted_at" IS '시도 시각 — (2026-10-08)';

COMMENT ON COLUMN "staff_member_retirement_logs"."contract_id" IS '퇴직일에 걸친 근로계약 — 참고, 처리 행만, 계약마다 한 줄';
COMMENT ON COLUMN "staff_member_retirement_logs"."previous_contract_end_date" IS '처리 시점 계약 종료일 — 참고용 (2026-10-08)';
