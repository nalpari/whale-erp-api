-- 직원 레코드(staff_members)의 본사 제공 동의 네 칸 · CHECK 셋을 지운다 (api #78 후속, 2026-10-20 노영주 요청).
--
-- 본사 제공 동의(운영 정책 ATT-30)는 api #78(20261020101015_team3_account_hq_sharing_consent)에서 계정(accounts)으로 옮겼고,
-- 직원 레코드의 칸은 그 뒤 아무 코드도 읽지 않는다. #78 이 같이 지우지 않은 것은 옛 Prisma 클라이언트가 select 없는 조회 ·
-- update 에 모든 칸을 실어, 먼저 지우면 #78 전 코드로 뜬 api 가 500 이기 때문이다.
-- **적용은 공용 서버가 #78 이후 코드로 재배포된 뒤** 한다. 팀원 로컬 api 도 #78 이후로 받아야 안 깨진다.
--
-- 지우기 전에 동의 기록이 남아 있는지 보고, 있으면 멈춘다 — 동의 칸 하나의 CHECK 가 「동의 시각 없이 버전만」을 막아서
-- 조건 두 개로 기록이 있는 행을 빠짐없이 잡는다. 잠금은 처음부터 ACCESS EXCLUSIVE 로 잡는다 — 검사와 지우기 사이에 값이
-- 들어오지 않고, 퇴직 처리(FOR UPDATE)와 교착하지 않는다(노영주가 일회용 postgres:18 에서 확인).

LOCK TABLE "staff_members" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE recorded INTEGER; sample INTEGER[];
BEGIN
    SELECT count(*), (array_agg("staff_member_id" ORDER BY "staff_member_id"))[1:5] INTO recorded, sample
        FROM "staff_members" WHERE "is_hq_sharing_consented" OR "hq_sharing_agreed_at" IS NOT NULL;
    IF recorded > 0 THEN
        RAISE EXCEPTION '직원 레코드에 본사 제공 동의 기록이 있다 — 지울 수 없다 (% 건, 예: %)', recorded, sample;
    END IF;
END $$;

-- DropCheck
ALTER TABLE "staff_members" DROP CONSTRAINT "staff_members_hq_sharing_consent_fields";
ALTER TABLE "staff_members" DROP CONSTRAINT "staff_members_hq_sharing_not_consented_fields";
ALTER TABLE "staff_members" DROP CONSTRAINT "staff_members_hq_sharing_withdrawn_after_agreed";

-- AlterTable
ALTER TABLE "staff_members"
    DROP COLUMN "is_hq_sharing_consented",
    DROP COLUMN "hq_sharing_consent_version",
    DROP COLUMN "hq_sharing_agreed_at",
    DROP COLUMN "hq_sharing_withdrawn_at";
