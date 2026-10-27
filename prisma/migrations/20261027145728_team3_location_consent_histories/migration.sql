-- 위치정보 동의 이력 location_consent_histories (WHALEERP-213 · 운영 정책 ATT-26, 2026-10-23 재영).
--
-- 동의 · 철회 · 잠시 멈춤 · 다시 켜기를 할 때마다 한 줄 남긴다. 확인자료(location_access_logs)의 처리 구분(수집 · 이용 · 제공)에는
-- 이 네 동작을 넣지 않는다. 약관 버전이 바뀌어 다시 동의하면 앞 동의에 철회, 새 동의에 동의 한 줄씩이다.
-- 이미 있는 동의는 남아 있는 시각(agreed_at · paused_at · withdrawn_at)으로 동의 · 잠시 멈춤 · 철회 줄을 채운다 — 그 사이의
-- 잠시 멈춤 · 다시 켜기는 기록이 없어 채우지 못한다.

-- CreateEnum
CREATE TYPE "location_consent_action" AS ENUM ('AGREE', 'WITHDRAW', 'PAUSE', 'RESUME');  -- 동의 · 철회 · 잠시 멈춤 · 다시 켜기
COMMENT ON TYPE "location_consent_action" IS '동의 · 철회 · 잠시 멈춤 · 다시 켜기';

-- CreateTable
CREATE TABLE "location_consent_histories" (
    "location_consent_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "location_consent_id" INTEGER NOT NULL,
    "action" "location_consent_action" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_consent_histories_pkey" PRIMARY KEY ("location_consent_history_id")
);

-- AddForeignKey
ALTER TABLE "location_consent_histories" ADD CONSTRAINT "location_consent_histories_location_consent_id_fkey" FOREIGN KEY ("location_consent_id") REFERENCES "location_consents" ("location_consent_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- CreateIndex
CREATE INDEX "location_consent_histories_location_consent_id_occurred_at_idx" ON "location_consent_histories" ("location_consent_id", "occurred_at");

COMMENT ON TABLE "location_consent_histories" IS '위치정보 동의 이력';
COMMENT ON COLUMN "location_consent_histories"."location_consent_history_id" IS '동의 이력 ID (논리 history_id)';
COMMENT ON COLUMN "location_consent_histories"."location_consent_id" IS '위치정보 동의 (논리 consent_id)';
COMMENT ON COLUMN "location_consent_histories"."action" IS '처리 구분 — 동의 · 철회 · 잠시 멈춤 · 다시 켜기 — 할 때마다 한 줄. 확인자료(location_access_logs)의 수집 · 이용 · 제공과 따로 둔다 (운영 정책 ATT-26, 2026-10-23 재영)';
COMMENT ON COLUMN "location_consent_histories"."occurred_at" IS '처리 일시 — (location_consent_id, occurred_at) 인덱스. 약관이 바뀌어 다시 동의하면 앞 동의에 철회, 새 동의에 동의 한 줄씩';

-- Backfill — 이미 있는 동의의 동의 · 잠시 멈춤 · 철회
INSERT INTO "location_consent_histories" ("location_consent_id", "action", "occurred_at")
SELECT "location_consent_id", 'AGREE'::"location_consent_action", "agreed_at" FROM "location_consents"
UNION ALL
SELECT "location_consent_id", 'PAUSE'::"location_consent_action", "paused_at" FROM "location_consents" WHERE "paused_at" IS NOT NULL
UNION ALL
SELECT "location_consent_id", 'WITHDRAW'::"location_consent_action", "withdrawn_at" FROM "location_consents" WHERE "withdrawn_at" IS NOT NULL;
