-- 본사 점포(stores.is_hq) — BP 마다 본사 점포 하나를 두고, BP 의 상호명 · 사업자정보를 bp_codes 에서
-- 본사 점포와 그 사업자정보(store_business_profiles)로 옮긴다(2026-11-17 사용자 결정, 설계안 「본사 점포 자동 등록 검토」 2판).
-- 본사 직원도 일반 점포 직원처럼 store_id 로 근로계약 · 근무스케줄 · 출퇴근 · 급여명세서 · TO-DO 를 탄다.
--
-- 순서가 중요하다 — 칸을 지우기 전에 옮기고, 다 옮겨졌는지 확인한 뒤 지운다. 한 트랜잭션이라 중간에 실패하면 모두 되돌린다.
--   1) stores.is_hq · store_business_profiles.biz_ceo_email 칸
--   2) bp_codes 마다 본사 점포 + 사업자정보(플랫폼 BP · 삭제한 BP 포함)
--   3) 확인 — 하나라도 어긋나면 RAISE EXCEPTION
--   4) 제약 — BP 당 살아 있는 본사 하나(부분 고유), 본사는 직영
--   5) bp_codes 에서 상호명 · 사업자정보 칸과 사업자번호 부분 고유 인덱스를 지운다
--
-- 본사 상태: 좌표가 아직 없어 모두 미운영으로 시작한다(운영 조건 = 사업자 인증 · 좌표 · BP 사용, 일반 점포와 같다).
-- 탈퇴한 BP 의 본사는 폐점(폐점일 = BP 마지막 수정일, 한국 날짜), 삭제한 BP 의 본사는 삭제 · 폐점이다 — 삭제한 BP 도
-- 상호명이 남아야 하므로 본사를 만든다. 점포코드는 지금 마지막 ST 번호 다음부터 bp_code_id 순으로 매긴다.
-- 사업장 주소는 본사 점포의 주소 칸에도 같이 넣는다(본사의 주소 = 사업장 주소, 좌표는 마이페이지 · 플랫폼 BP 수정에서 넣는다).
--
-- 잃는 것: 사업자번호의 DB 고유 보장(bp_codes_biz_registration_number_key). 이제 고유는 코드 검사와 가입 · 등록
-- 트랜잭션의 advisory lock 이 맡는다 — 점포끼리의 번호 고유도 원래 그 방식이다.

BEGIN;

-- 1) 칸
ALTER TABLE "stores" ADD COLUMN "is_hq" BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN "stores"."is_hq" IS '본사 점포 여부 — BP 마다 살아 있는 본사 하나(부분 유일), 직영 고정. 가입 · 플랫폼 BP 등록 때 시스템이 만들고 점포 관리에서는 보이지 않는다. BP 상호명 · 사업자정보는 이 점포의 store_business_profiles 에 있다';
ALTER TABLE "store_business_profiles" ADD COLUMN "biz_ceo_email" TEXT;
COMMENT ON COLUMN "store_business_profiles"."biz_ceo_email" IS '대표자 이메일 — 본사 점포만 쓴다(플랫폼 BP 등록). BP 탈퇴 때 삭제(개인정보)';
COMMENT ON COLUMN "store_business_profiles"."biz_trade_name" IS '상호명 — 직접 입력, 인증과 무관. 본사 점포는 늘 채우며 BP 상호명의 원본이다';

-- 2) 본사 점포 + 사업자정보
WITH last_code AS (
  SELECT COALESCE(MAX(substring("store_code" FROM 3)::int), 0) AS n FROM "stores"
), numbered AS (
  SELECT b.*, ROW_NUMBER() OVER (ORDER BY b."bp_code_id") AS rn FROM "bp_codes" b
)
INSERT INTO "stores" (
  "store_code", "bp_code_id", "store_type_code", "name", "zip_code", "address", "address_detail",
  "store_status_code", "closed_date", "is_deleted", "is_hq", "created_at", "created_by", "updated_at", "updated_by"
)
SELECT
  'ST' || lpad((last_code.n + numbered.rn)::text, 6, '0'),
  numbered."bp_code_id",
  'DIRECT',
  numbered."trade_name",
  numbered."biz_zip_code",
  numbered."biz_address",
  numbered."biz_address_detail",
  CASE WHEN numbered."is_deleted" OR numbered."account_status_code" = 'WITHDRAWN' THEN 'CLOSED' ELSE 'NOT_OPERATING' END,
  CASE WHEN numbered."is_deleted" OR numbered."account_status_code" = 'WITHDRAWN'
       THEN (numbered."updated_at" AT TIME ZONE 'Asia/Seoul')::date END,
  numbered."is_deleted",
  true,
  numbered."created_at",
  numbered."created_by",
  numbered."updated_at",
  numbered."updated_by"
FROM numbered CROSS JOIN last_code;

INSERT INTO "store_business_profiles" (
  "store_id", "biz_trade_name", "biz_registration_number", "biz_ceo_name", "biz_open_date", "biz_ceo_phone",
  "biz_ceo_email", "biz_zip_code", "biz_address", "biz_address_detail", "biz_category", "biz_item", "biz_verified_at",
  "created_at", "created_by", "updated_at", "updated_by"
)
SELECT
  s."store_id", b."trade_name", b."biz_registration_number", b."biz_ceo_name", b."biz_open_date", b."biz_ceo_phone",
  b."biz_ceo_email", b."biz_zip_code", b."biz_address", b."biz_address_detail", b."biz_category", b."biz_item",
  b."biz_verified_at", b."created_at", b."created_by", b."updated_at", b."updated_by"
FROM "bp_codes" b
JOIN "stores" s ON s."bp_code_id" = b."bp_code_id" AND s."is_hq";

INSERT INTO "store_change_histories" ("store_id", "field", "before_value", "after_value", "changed_by", "changed_at", "retain_end_date")
SELECT s."store_id", '등록', NULL, s."name", NULL, now(), ((now() AT TIME ZONE 'Asia/Seoul')::date + INTERVAL '5 years')::date
FROM "stores" s WHERE s."is_hq";

-- 3) 확인
DO $$
DECLARE
  bp_count int;
  hq_count int;
  mismatch int;
BEGIN
  SELECT count(*) INTO bp_count FROM "bp_codes";
  SELECT count(*) INTO hq_count FROM "stores" WHERE "is_hq";
  IF hq_count <> bp_count THEN
    RAISE EXCEPTION '본사 점포 수(%)가 BP 수(%)와 다르다', hq_count, bp_count;
  END IF;

  SELECT count(*) INTO mismatch
  FROM "bp_codes" b
  LEFT JOIN "stores" s ON s."bp_code_id" = b."bp_code_id" AND s."is_hq"
  LEFT JOIN "store_business_profiles" p ON p."store_id" = s."store_id"
  WHERE p."store_id" IS NULL
     OR p."biz_trade_name" IS DISTINCT FROM b."trade_name"
     OR p."biz_registration_number" IS DISTINCT FROM b."biz_registration_number"
     OR p."biz_ceo_name" IS DISTINCT FROM b."biz_ceo_name"
     OR p."biz_open_date" IS DISTINCT FROM b."biz_open_date"
     OR p."biz_ceo_phone" IS DISTINCT FROM b."biz_ceo_phone"
     OR p."biz_ceo_email" IS DISTINCT FROM b."biz_ceo_email"
     OR p."biz_zip_code" IS DISTINCT FROM b."biz_zip_code"
     OR p."biz_address" IS DISTINCT FROM b."biz_address"
     OR p."biz_address_detail" IS DISTINCT FROM b."biz_address_detail"
     OR p."biz_category" IS DISTINCT FROM b."biz_category"
     OR p."biz_item" IS DISTINCT FROM b."biz_item"
     OR p."biz_verified_at" IS DISTINCT FROM b."biz_verified_at"
     OR s."name" IS DISTINCT FROM b."trade_name"
     OR s."store_type_code" <> 'DIRECT';
  IF mismatch > 0 THEN
    RAISE EXCEPTION '본사 점포 사업자정보가 BP 와 다른 행이 % 개다', mismatch;
  END IF;

  IF (SELECT count(*) FROM "store_change_histories" h JOIN "stores" s ON s."store_id" = h."store_id"
      WHERE s."is_hq" AND h."field" = '등록') <> hq_count THEN
    RAISE EXCEPTION '본사 점포 등록 이력 수가 본사 수와 다르다';
  END IF;
END $$;

-- 4) 제약
CREATE UNIQUE INDEX "stores_bp_code_id_is_hq_key" ON "stores" ("bp_code_id") WHERE "is_hq" AND NOT "is_deleted";  -- BP 당 살아 있는 본사 하나
ALTER TABLE "stores" ADD CONSTRAINT "stores_is_hq_direct" CHECK (NOT "is_hq" OR "store_type_code" = 'DIRECT');

-- 5) bp_codes 에서 옮긴 칸 지우기 — 칸에 걸린 CHECK(trade_name · biz_category · biz_item 길이)는 칸과 함께 지워진다
DROP INDEX "bp_codes_biz_registration_number_key";
ALTER TABLE "bp_codes"
  DROP COLUMN "trade_name",
  DROP COLUMN "biz_registration_number",
  DROP COLUMN "biz_ceo_name",
  DROP COLUMN "biz_open_date",
  DROP COLUMN "biz_ceo_phone",
  DROP COLUMN "biz_ceo_email",
  DROP COLUMN "biz_zip_code",
  DROP COLUMN "biz_address",
  DROP COLUMN "biz_address_detail",
  DROP COLUMN "biz_category",
  DROP COLUMN "biz_item",
  DROP COLUMN "biz_verified_at";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'bp_codes' AND column_name = 'trade_name') THEN
    RAISE EXCEPTION 'bp_codes.trade_name 이 남아 있다';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema()
                 AND indexname = 'stores_bp_code_id_is_hq_key' AND indexdef LIKE '%WHERE%') THEN
    RAISE EXCEPTION 'stores_bp_code_id_is_hq_key 부분 고유 인덱스가 없다';
  END IF;
END $$;

COMMIT;
