-- 본사 제공 동의를 계정에 둔다 (2026-10-20 노영주). 한 직원이 소속 점포마다 다르게 고르지 않으므로 계정에 하나만 두고,
-- 소속 가맹 점포 모두에 같이 적용한다. 처음에는 직원 레코드에 두었다 (#137, 20261013091102_team3_staff_member_hq_sharing_consent).
--
-- 값은 옮기지 않는다. 동의를 저장하는 코드가 아직 없어 직원 레코드의 네 칸은 모두 기본값(동의 안 함)이고, 계정도 기본값으로
-- 시작한다. 직원 레코드의 네 칸 · CHECK 셋은 여기서 지우지 않는다 — 아무 코드도 읽지 않지만, 옛 Prisma 클라이언트는 select 없는
-- 조회 · update 에 모든 칸을 실어 먼저 지우면 이 마이그레이션 전 코드로 뜬 api 가 500 이다. 지우는 것은 staff_members 담당(민식)이
-- 공용 서버 재배포 뒤 다음 마이그레이션으로 한다. 그때까지 칸 설명에 「안 씀」을 적어 둔다.
ALTER TABLE "accounts"
    ADD COLUMN "is_hq_sharing_consented" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "hq_sharing_consent_version" TEXT,
    ADD COLUMN "hq_sharing_agreed_at" TIMESTAMPTZ(6),
    ADD COLUMN "hq_sharing_withdrawn_at" TIMESTAMPTZ(6);

-- 동의 중이면 버전 · 동의 시각이 있고 철회 시각은 없다. 동의 안 함이면 셋 다 없거나(동의한 적 없음) 셋 다 있다(철회함).
-- 철회 시각은 동의 시각 뒤다. 모든 계정이 기본값이라 제약을 바로 지킨다.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_hq_sharing_consent_fields" CHECK (NOT "is_hq_sharing_consented" OR ("hq_sharing_consent_version" IS NOT NULL AND "hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" IS NULL));
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_hq_sharing_not_consented_fields" CHECK ("is_hq_sharing_consented" OR ("hq_sharing_consent_version" IS NULL AND "hq_sharing_agreed_at" IS NULL AND "hq_sharing_withdrawn_at" IS NULL) OR ("hq_sharing_consent_version" IS NOT NULL AND "hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" IS NOT NULL));
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_hq_sharing_withdrawn_after_agreed" CHECK ("hq_sharing_withdrawn_at" IS NULL OR ("hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" >= "hq_sharing_agreed_at"));

COMMENT ON COLUMN "accounts"."is_hq_sharing_consented" IS '본사 제공 동의 — 가맹 점포 직원을 BP 마스터 · BP 관리자에게 보일지 정한다. 계정에 하나 — 소속 가맹 점포 모두에 같이 적용 (2026-10-20). 철회하면 false (물리에서 추가)';
COMMENT ON COLUMN "accounts"."hq_sharing_consent_version" IS '본사 제공 동의 문구 버전 — 동의한 문구의 버전 (물리에서 추가)';
COMMENT ON COLUMN "accounts"."hq_sharing_agreed_at" IS '본사 제공 동의 일시 — 다시 동의하면 그 시각으로 바뀐다 (물리에서 추가)';
COMMENT ON COLUMN "accounts"."hq_sharing_withdrawn_at" IS '본사 제공 동의 철회 일시 — 철회하지 않았으면 NULL (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."is_hq_sharing_consented" IS '본사 제공 동의 — 안 씀 — 계정(accounts)으로 옮겼다 (2026-10-20). 삭제 예정. 처음 둔 것은 #137, 2026-10-12 재영 (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."hq_sharing_consent_version" IS '본사 제공 동의 문구 버전 — 안 씀 — 계정으로 옮겼다. 삭제 예정 (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."hq_sharing_agreed_at" IS '본사 제공 동의 일시 — 안 씀 — 계정으로 옮겼다. 삭제 예정 (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."hq_sharing_withdrawn_at" IS '본사 제공 동의 철회 일시 — 안 씀 — 계정으로 옮겼다. 삭제 예정 (물리에서 추가)';
