-- 본사 제공 동의를 직원 레코드에서 계정으로 옮긴다 (2026-10-20 노영주). 한 직원이 소속 점포마다 다르게 고르지 않으므로
-- 계정에 하나만 두고, 소속 가맹 점포 모두에 같이 적용한다. 처음에는 직원 레코드에 두었다 (#137,
-- 20261013091102_team3_staff_member_hq_sharing_consent).
--
-- 값은 옮기지 않는다. 동의를 저장하는 코드가 아직 없어 직원 레코드의 네 칸은 모두 기본값(동의 안 함)이고, 계정도 기본값으로
-- 시작한다. 동의는 계정의 값 하나이므로 레코드 여럿 가운데 고를 규칙을 두지 않는다. 그래도 동의 기록이 있는 레코드가 하나라도
-- 있으면 버리지 않도록 멈춘다 — 그때는 옮길 값을 정한 뒤 다시 쓴다.
ALTER TABLE "accounts"
    ADD COLUMN "is_hq_sharing_consented" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "hq_sharing_consent_version" TEXT,
    ADD COLUMN "hq_sharing_agreed_at" TIMESTAMPTZ(6),
    ADD COLUMN "hq_sharing_withdrawn_at" TIMESTAMPTZ(6);

-- 확인과 칸 지우기 사이에 다른 트랜잭션이 동의를 쓰지 못하게 먼저 잠근다(읽기는 막지 않는다).
LOCK TABLE "staff_members" IN SHARE MODE;

DO $$
DECLARE
    recorded INTEGER;
    sample INTEGER[];
BEGIN
    SELECT count(*), (array_agg("staff_member_id" ORDER BY "staff_member_id"))[1:5]
        INTO recorded, sample
        FROM "staff_members" WHERE "is_hq_sharing_consented" OR "hq_sharing_agreed_at" IS NOT NULL;
    IF recorded > 0 THEN
        RAISE EXCEPTION '직원 레코드에 본사 제공 동의 기록이 있다 — 계정으로 옮길 값을 정하지 않고 지울 수 없다 (% 건, 예: %)',
            recorded, sample;
    END IF;
END $$;

-- 동의 중이면 버전 · 동의 시각이 있고 철회 시각은 없다. 동의 안 함이면 셋 다 없거나(동의한 적 없음) 셋 다 있다(철회함).
-- 철회 시각은 동의 시각 뒤다. 모든 계정이 기본값이라 제약을 바로 지킨다.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_hq_sharing_consent_fields" CHECK (NOT "is_hq_sharing_consented" OR ("hq_sharing_consent_version" IS NOT NULL AND "hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" IS NULL));
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_hq_sharing_not_consented_fields" CHECK ("is_hq_sharing_consented" OR ("hq_sharing_consent_version" IS NULL AND "hq_sharing_agreed_at" IS NULL AND "hq_sharing_withdrawn_at" IS NULL) OR ("hq_sharing_consent_version" IS NOT NULL AND "hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" IS NOT NULL));
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_hq_sharing_withdrawn_after_agreed" CHECK ("hq_sharing_withdrawn_at" IS NULL OR ("hq_sharing_agreed_at" IS NOT NULL AND "hq_sharing_withdrawn_at" >= "hq_sharing_agreed_at"));

ALTER TABLE "staff_members" DROP CONSTRAINT "staff_members_hq_sharing_consent_fields";
ALTER TABLE "staff_members" DROP CONSTRAINT "staff_members_hq_sharing_not_consented_fields";
ALTER TABLE "staff_members" DROP CONSTRAINT "staff_members_hq_sharing_withdrawn_after_agreed";
ALTER TABLE "staff_members"
    DROP COLUMN "is_hq_sharing_consented",
    DROP COLUMN "hq_sharing_consent_version",
    DROP COLUMN "hq_sharing_agreed_at",
    DROP COLUMN "hq_sharing_withdrawn_at";

COMMENT ON COLUMN "accounts"."is_hq_sharing_consented" IS '본사 제공 동의 — 가맹 점포 직원을 BP 마스터 · BP 관리자에게 보일지 정한다. 계정에 하나 — 소속 가맹 점포 모두에 같이 적용 (2026-10-20). 철회하면 false (물리에서 추가)';
COMMENT ON COLUMN "accounts"."hq_sharing_consent_version" IS '본사 제공 동의 문구 버전 — 동의한 문구의 버전 (물리에서 추가)';
COMMENT ON COLUMN "accounts"."hq_sharing_agreed_at" IS '본사 제공 동의 일시 — 다시 동의하면 그 시각으로 바뀐다 (물리에서 추가)';
COMMENT ON COLUMN "accounts"."hq_sharing_withdrawn_at" IS '본사 제공 동의 철회 일시 — 철회하지 않았으면 NULL (물리에서 추가)';
