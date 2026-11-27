-- 직원 앱 약관 동의 (WHALEERP-774 · 운영 정책 ACC-23).
--
-- 직원 앱 가입이 서비스 이용약관 · 개인정보 수집·이용(필수 둘)과 마케팅 정보 수신(선택)에 동의를 받는다. 이미 가입한 직원은
-- 로그인 뒤 홈에서 받는다. 동의 이력은 1팀 표 terms_agreement_logs 를 넓히지 않고 직원 계정용 표를 따로 둔다(2026-11-27 김민식) —
-- 1팀 표는 admin_account_id 가 NOT NULL 이고, 위치정보 동의(location_consents)처럼 직원 쪽 동의는 계정 기준으로 따로 둔다.
-- 약관 버전(terms_versions)과 동의 경로 enum(terms_agreement_channel)은 1팀 것을 참조만 한다.
--
-- accounts.terms_agreed_at 은 필수 약관 둘에 동의한 시각이다. 비어 있으면 앱이 동의를 받는다 — 이미 가입한 계정은 모두 비어 있다.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "terms_agreed_at" TIMESTAMPTZ(6);
COMMENT ON COLUMN "accounts"."terms_agreed_at" IS '약관 동의 일시 — 서비스 이용약관 · 개인정보 수집·이용(필수 둘)에 동의한 시각. 비어 있으면 앱이 동의를 받는다 (ACC-23, WHALEERP-774)';

-- CreateTable
CREATE TABLE "account_terms_agreement_logs" (
    "account_terms_agreement_log_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "terms_version_id" INTEGER NOT NULL,
    "is_agreed" BOOLEAN NOT NULL,
    "agreed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" "terms_agreement_channel" NOT NULL,
    "client_address" TEXT,

    CONSTRAINT "account_terms_agreement_logs_pkey" PRIMARY KEY ("account_terms_agreement_log_id")
);

-- AddForeignKey
ALTER TABLE "account_terms_agreement_logs" ADD CONSTRAINT "account_terms_agreement_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "account_terms_agreement_logs" ADD CONSTRAINT "account_terms_agreement_logs_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "terms_versions" ("terms_version_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- CreateIndex
CREATE INDEX "account_terms_agreement_logs_account_id_idx" ON "account_terms_agreement_logs" ("account_id");

COMMENT ON TABLE "account_terms_agreement_logs" IS '직원 계정 약관 동의 이력';
COMMENT ON COLUMN "account_terms_agreement_logs"."account_terms_agreement_log_id" IS '동의 이력 ID';
COMMENT ON COLUMN "account_terms_agreement_logs"."account_id" IS '직원 계정 — accounts FK';
COMMENT ON COLUMN "account_terms_agreement_logs"."terms_version_id" IS '약관 버전 — terms_versions FK';
COMMENT ON COLUMN "account_terms_agreement_logs"."is_agreed" IS '동의 여부 — 선택 약관(마케팅 정보 수신)은 동의하지 않아도 한 줄 남는다';
COMMENT ON COLUMN "account_terms_agreement_logs"."agreed_at" IS '동의 일시';
COMMENT ON COLUMN "account_terms_agreement_logs"."channel" IS '동의 경로 — 회원가입 · 최초 로그인(이미 가입한 직원이 홈에서 동의)';
COMMENT ON COLUMN "account_terms_agreement_logs"."client_address" IS '접속 IP';
