-- 가맹 점포 직원의 본사 제공 동의(#137, 2026-10-12 재영 결정, 명세 「직원 초대와 가입 확인」 데이터 슬롯).
-- 동의 여부 · 동의한 문구 버전 · 동의 시각 · 철회 시각. 이 값으로 BP 마스터 · BP 관리자에게 가맹 점포 직원을 보일지 정한다.
-- 기존 직원 레코드는 동의하지 않은 것(false)으로 시작한다. 동의하지 않은 직원을 가리는 것은 조회 API 를 만들 때 넣는다.
ALTER TABLE "staff_members"
    ADD COLUMN "is_hq_sharing_consented" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "hq_sharing_consent_version" TEXT,
    ADD COLUMN "hq_sharing_agreed_at" TIMESTAMPTZ(6),
    ADD COLUMN "hq_sharing_withdrawn_at" TIMESTAMPTZ(6);

-- 동의 중이면 버전 · 동의 시각이 있고 철회 시각은 없다. 동의 안 함이면 셋 다 없거나(동의한 적 없음) 셋 다 있다(철회함).
-- 철회 시각은 동의 시각 뒤다.
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_hq_sharing_consent_fields" CHECK (NOT "is_hq_sharing_consented" OR ("hq_sharing_consent_version" IS NOT NULL AND "hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" IS NULL));
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_hq_sharing_not_consented_fields" CHECK ("is_hq_sharing_consented" OR ("hq_sharing_consent_version" IS NULL AND "hq_sharing_agreed_at" IS NULL AND "hq_sharing_withdrawn_at" IS NULL) OR ("hq_sharing_consent_version" IS NOT NULL AND "hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" IS NOT NULL));
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_hq_sharing_withdrawn_after_agreed" CHECK ("hq_sharing_withdrawn_at" IS NULL OR ("hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" >= "hq_sharing_agreed_at"));

COMMENT ON COLUMN "staff_members"."is_hq_sharing_consented" IS '본사 제공 동의 — 가맹 점포 직원을 BP 마스터 · BP 관리자에게 보일지 정한다 (#137, 2026-10-12 재영, 명세 「직원 초대와 가입 확인」). 철회하면 false (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."hq_sharing_consent_version" IS '본사 제공 동의 문구 버전 — 동의한 문구의 버전 (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."hq_sharing_agreed_at" IS '본사 제공 동의 일시 — 다시 동의하면 그 시각으로 바뀐다 (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."hq_sharing_withdrawn_at" IS '본사 제공 동의 철회 일시 — 철회하지 않았으면 NULL (물리에서 추가)';
