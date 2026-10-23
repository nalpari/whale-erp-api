-- 점포 연락처에 050X 평생번호(예 0507-2033-1334, 숫자 12자리)를 받는다 (2026-10-23). 초기 DDL 의
-- stores_phone_format 이 9~11자리만 받아, 앱 검증(SaveStoreDto.phone)만 넓히면 12자리가 DB 에서 막혀 500 이 된다.
-- 그래서 CHECK 를 9~12자리로 다시 만든다. 대표자 연락처(store_business_profiles_biz_ceo_phone_format,
-- 10~11자리)는 그대로다. 넓히기만 하므로 기존 행은 모두 새 조건을 만족한다.
--
-- CHECK 는 schema.prisma 가 표현하지 못해 이 SQL 에만 있다(db:pull 해도 schema.prisma 에는 나타나지 않는다).

ALTER TABLE "stores" DROP CONSTRAINT "stores_phone_format";
ALTER TABLE "stores" ADD CONSTRAINT "stores_phone_format" CHECK ("phone" ~ '^[0-9]{9,12}$');

COMMENT ON COLUMN "stores"."phone" IS '점포 연락처 — 숫자 9~12자리(12자리는 050X 평생번호)';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'stores_phone_format'
                    AND conrelid = '"stores"'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%{9,12}%') THEN
    RAISE EXCEPTION 'stores_phone_format 이 9~12자리로 바뀌지 않았다';
  END IF;
END $$;
