-- 1팀 메뉴의 연락처를 점포 연락처(stores_phone_format, 20261023103403)와 같은 숫자 9~12자리로 맞춘다
-- (2026-10-27). 02 지역번호 9자리와 050X 평생번호 12자리를 받는다. 관리자 계정 연락처(회원가입 · 내 정보 ·
-- BP 관리자 · 플랫폼 관리자)와 점포 대표자 연락처는 CHECK 가 10~11자리라, 앱 검증만 넓히면 9 · 12자리가
-- DB 에서 막혀 500 이 된다. 그래서 두 CHECK 를 같은 이름으로 다시 만든다. BP 대표자 연락처(bp_codes.biz_ceo_phone)는
-- CHECK 가 없어 앱 검증만 바꾼다. 넓히기만 하므로 기존 행은 모두 새 조건을 만족한다.
--
-- CHECK 는 schema.prisma 가 표현하지 못해 이 SQL 에만 있다(db:pull 해도 schema.prisma 에는 나타나지 않는다).

ALTER TABLE "admin_accounts" DROP CONSTRAINT "admin_accounts_phone_format";
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_phone_format" CHECK ("phone" ~ '^[0-9]{9,12}$');

ALTER TABLE "store_business_profiles" DROP CONSTRAINT "store_business_profiles_biz_ceo_phone_format";
ALTER TABLE "store_business_profiles" ADD CONSTRAINT "store_business_profiles_biz_ceo_phone_format" CHECK ("biz_ceo_phone" ~ '^[0-9]{9,12}$');

COMMENT ON COLUMN "admin_accounts"."phone" IS '연락처 — 숫자 9~12자리(12자리는 050X 평생번호)';
COMMENT ON COLUMN "store_business_profiles"."biz_ceo_phone" IS '대표자 연락처 — 숫자 9~12자리(12자리는 050X 평생번호)';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'admin_accounts_phone_format'
                    AND conrelid = '"admin_accounts"'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%{9,12}%') THEN
    RAISE EXCEPTION 'admin_accounts_phone_format 이 9~12자리로 바뀌지 않았다';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'store_business_profiles_biz_ceo_phone_format'
                    AND conrelid = '"store_business_profiles"'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%{9,12}%') THEN
    RAISE EXCEPTION 'store_business_profiles_biz_ceo_phone_format 이 9~12자리로 바뀌지 않았다';
  END IF;
END $$;
