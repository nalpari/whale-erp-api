-- 시설물 및 장비 관리 (2026-11-11). 「시설물·장비 관리 정책서」(2026-11-10) PL-1 ~ PL-6 의 데이터다.
--
-- 시설물·장비 한 건은 점포 하나에 속하고(store_id, 등록 뒤 바꾸지 않는다), 기본 정보와 관리 정보(제품 · 구매 · 기한 ·
-- 관리 · A/S)를 한 행에 담는다 — 관리 정보는 따로 지우지 않고 칸을 비워 저장하므로 행을 나눌 까닭이 없다. 문서 3종
-- (사용 매뉴얼 · 주의사항 · 제품 보증서)은 종류마다 1개라 facility_documents 에 따로 둔다. 둘 다 논리 삭제다.
--
-- 1팀 ERD 생성기(front docs/erd/team1/_build_physical.py)에는 아직 이 표가 없다 — 이 파일이 먼저다. ERD 에 넣을 때
-- 이 DDL 과 맞춘다(okf domain/team1-physical-schema.md).
--
-- 공통코드 그룹 4개를 함께 넣는다(정책서 제안 이름, 2026-11-11 사용자 결정):
--   FACILITY_STATUS(시설물 운영상태, 플랫폼고정) · STORE_FACILITY(점포 시설물) · STORE_EQUIPMENT(점포 장비) ·
--   INSPECTION_CYCLE(시설물 점검 주기) — 뒤의 셋은 플랫폼제공이고 BP 적용은 꺼 둔다. 지금 있는 BP 는 운영자가 공통코드
--   관리에서 [BP에 적용]을 켤 때 상세 코드를 받고, 그 전에는 분류 · 점검 주기 선택지가 비어 시설물을 등록할 수 없다(분류
--   필수). 이 뒤에 가입 · 등록하는 BP 는 적용 여부와 관계없이 가입 때 플랫폼제공 그룹 전부를 받는다(providedOriginals).
--   배포 뒤 할 일: STORE_FACILITY · STORE_EQUIPMENT(필요하면 INSPECTION_CYCLE)의 BP 적용.
--   점검 주기만 제안(FACILITY_INSPECTION_CYCLE, 25자)과 다르다 — 그룹 코드는 20자까지다(code_groups_group_code_format).
--   기본 분류는 목업 견본 값이다(점포 시설물: 식재보관 · 급수 · 냉난방, 점포 장비: 그라인더 · 커피머신 · 제빙기).
--   수리비 결제 수단은 수리 이력과 함께 넣는다 — 제안 REPAIR_PAYMENT_METHOD 도 21자라 이름을 다시 정해야 한다.
--
-- 메뉴 MN000022 「시설물 및 장비 관리」의 url 을 한 단계 경로 /facilities 로 바꾸고 사용으로 돌린다 — 권한 가드가 컨트롤러
-- 경로의 첫 단계로 메뉴를 찾는다. 고정 권한 그룹 BP 마스터(BM000001) · 가맹 마스터(FM000001)에 조회 · 등록 · 수정 · 삭제를
-- 준다(플랫폼 마스터 PM000001 은 초기 데이터에 이미 있다). 가맹 계정도 자기 점포의 장비를 등록 · 관리한다(정책서 PL-1).

CREATE TYPE "facility_document_kind" AS ENUM ('USER_MANUAL', 'PRECAUTION', 'WARRANTY');  -- 사용 매뉴얼 · 주의사항 · 제품 보증서
COMMENT ON TYPE "facility_document_kind" IS '사용 매뉴얼 · 주의사항 · 제품 보증서';

CREATE TABLE "facilities" (
    "facility_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "store_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "facility_status_code" TEXT NOT NULL,
    "facility_group_code" TEXT NOT NULL,
    "facility_category_code" TEXT NOT NULL,
    "memo" TEXT,
    "brand" TEXT,
    "manufacturer" TEXT,
    "serial_number" TEXT,
    "installation_location" TEXT,
    "vendor_name" TEXT,
    "vendor_phone" TEXT,
    "sales_representative_name" TEXT,
    "sales_representative_phone" TEXT,
    "unit_price_amount" NUMERIC(10,0),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "total_amount" NUMERIC(14,0),
    "is_vat_included" BOOLEAN NOT NULL DEFAULT true,
    "purchase_date" DATE,
    "installation_date" DATE,
    "usage_expiry_date" DATE,
    "warranty_expiry_date" DATE,
    "manager_staff_member_id" INTEGER,
    "manager_phone" TEXT,
    "inspection_cycle_code" TEXT,
    "inspection_note" TEXT,
    "service_center_zip_code" TEXT,
    "service_center_address" TEXT,
    "service_center_address_detail" TEXT,
    "service_center_phone" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("facility_id")
);

ALTER TABLE "facilities" ADD CONSTRAINT "facilities_name_length" CHECK (char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_facility_group_code_allowed" CHECK ("facility_group_code" IN ('STORE_FACILITY', 'STORE_EQUIPMENT'));
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_memo_length" CHECK (char_length("memo") <= 200);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_product_text_length" CHECK (
  char_length("brand") <= 100 AND char_length("manufacturer") <= 100
  AND char_length("serial_number") <= 100 AND char_length("installation_location") <= 100);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_purchase_text_length" CHECK (char_length("vendor_name") <= 100 AND char_length("sales_representative_name") <= 50);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_phone_format" CHECK (
  "vendor_phone" ~ '^[0-9]{9,12}$' AND "sales_representative_phone" ~ '^[0-9]{9,12}$'
  AND "manager_phone" ~ '^[0-9]{9,12}$' AND "service_center_phone" ~ '^[0-9]{9,12}$');
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_unit_price_amount_range" CHECK ("unit_price_amount" >= 0);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_quantity_range" CHECK ("quantity" BETWEEN 1 AND 9999);
-- 총금액은 단가 × 수량이다 — 서버가 계산해 넣고, 단가가 없으면 총금액도 없다. `=` 로 쓰면 한쪽만 NULL 인 행이
-- NULL(통과)이 되므로 IS NOT DISTINCT FROM 으로 둘 다 막는다.
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_total_amount_product" CHECK (
  "total_amount" IS NOT DISTINCT FROM "unit_price_amount" * "quantity");
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_installation_date_after_purchase" CHECK ("installation_date" >= "purchase_date");
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_inspection_note_length" CHECK (char_length("inspection_note") <= 200);
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_service_center_zip_code_format" CHECK ("service_center_zip_code" ~ '^[0-9]{5}$');
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_service_center_address_length" CHECK (
  char_length("service_center_address") <= 200 AND char_length("service_center_address_detail") <= 100);
-- 상세주소는 기본주소를 고른 뒤에만, 우편번호와 기본주소는 함께다(공통 주소 칸).
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_service_center_address_complete" CHECK (
  ("service_center_zip_code" IS NULL) = ("service_center_address" IS NULL)
  AND ("service_center_address_detail" IS NULL OR "service_center_address" IS NOT NULL));

ALTER TABLE "facilities" ADD CONSTRAINT "facilities_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_manager_staff_member_id_fkey" FOREIGN KEY ("manager_staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "facilities_store_id_idx" ON "facilities" ("store_id");

COMMENT ON TABLE "facilities" IS '시설물·장비';
COMMENT ON COLUMN "facilities"."facility_id" IS '시설물·장비 ID';
COMMENT ON COLUMN "facilities"."store_id" IS '점포 — stores FK. 등록 뒤 바꾸지 않는다(정책서 PL-1)';
COMMENT ON COLUMN "facilities"."name" IS '시설물/장비명 — 1~100자';
COMMENT ON COLUMN "facilities"."facility_status_code" IS '운영상태 — 공통코드 FACILITY_STATUS(플랫폼고정: 운영 · 보관 · 폐기). 수리 이력 · 점검표가 생기면 운영인 것만 그 대상으로 고른다';
COMMENT ON COLUMN "facilities"."facility_group_code" IS '그룹 — 공통코드 그룹 STORE_FACILITY(점포 시설물) · STORE_EQUIPMENT(점포 장비)';
COMMENT ON COLUMN "facilities"."facility_category_code" IS '분류 — 그룹(facility_group_code)의 상세 코드. 점포 BP 의 행';
COMMENT ON COLUMN "facilities"."memo" IS '메모 — 200자';
COMMENT ON COLUMN "facilities"."brand" IS '브랜드';
COMMENT ON COLUMN "facilities"."manufacturer" IS '제조사';
COMMENT ON COLUMN "facilities"."serial_number" IS 'Serial number';
COMMENT ON COLUMN "facilities"."installation_location" IS '설치 위치';
COMMENT ON COLUMN "facilities"."vendor_name" IS '구매처';
COMMENT ON COLUMN "facilities"."vendor_phone" IS '구매처 전화번호 — 숫자 9~12자리';
COMMENT ON COLUMN "facilities"."sales_representative_name" IS '영업사원';
COMMENT ON COLUMN "facilities"."sales_representative_phone" IS '영업사원 전화번호 — 숫자 9~12자리';
COMMENT ON COLUMN "facilities"."unit_price_amount" IS '단가 — 원, 숫자 10자리까지';
COMMENT ON COLUMN "facilities"."quantity" IS '수량 — 1~9,999, 기본 1';
COMMENT ON COLUMN "facilities"."total_amount" IS '총금액 — 단가 × 수량, 서버가 계산. 단가가 없으면 비움';
COMMENT ON COLUMN "facilities"."is_vat_included" IS '부가세 포함 — 단가 · 총금액이 부가세 포함 금액인가. 기본 포함';
COMMENT ON COLUMN "facilities"."purchase_date" IS '구매일';
COMMENT ON COLUMN "facilities"."installation_date" IS '설치일 — 구매일보다 앞서지 않는다';
COMMENT ON COLUMN "facilities"."usage_expiry_date" IS '사용 유효기한';
COMMENT ON COLUMN "facilities"."warranty_expiry_date" IS '품질 보증기한';
COMMENT ON COLUMN "facilities"."manager_staff_member_id" IS '관리 담당자 — staff_members FK. 고를 때 그 점포의 재직 직원';
COMMENT ON COLUMN "facilities"."manager_phone" IS '관리 담당자 전화번호 — 숫자 9~12자리. 담당자 휴대폰으로 미리 채우고 고칠 수 있다';
COMMENT ON COLUMN "facilities"."inspection_cycle_code" IS '점검 주기 — 공통코드 INSPECTION_CYCLE(플랫폼제공). 점포 BP 의 행';
COMMENT ON COLUMN "facilities"."inspection_note" IS '점검 비고 — 200자';
COMMENT ON COLUMN "facilities"."service_center_zip_code" IS 'A/S센터 우편번호 — 5자리, 주소 검색으로만 채움';
COMMENT ON COLUMN "facilities"."service_center_address" IS 'A/S센터 기본주소(도로명)';
COMMENT ON COLUMN "facilities"."service_center_address_detail" IS 'A/S센터 상세주소 — 100자';
COMMENT ON COLUMN "facilities"."service_center_phone" IS 'A/S센터 전화번호 — 숫자 9~12자리';
COMMENT ON COLUMN "facilities"."is_deleted" IS '삭제 여부 — 잘못 등록한 것을 지운다. 수리 이력 · 점검 결과가 생기면 그것이 있는 행은 지우지 않고 폐기로 바꾸게 한다(정책서 PL-4, 미구현)';
COMMENT ON COLUMN "facilities"."created_at" IS '등록 일시';
COMMENT ON COLUMN "facilities"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "facilities"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "facilities"."updated_by" IS '수정자 — admin_accounts FK';

CREATE TABLE "facility_documents" (
    "facility_document_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "facility_id" INTEGER NOT NULL,
    "document_kind" "facility_document_kind" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" "attachment_file_type" NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER NOT NULL,

    CONSTRAINT "facility_documents_pkey" PRIMARY KEY ("facility_document_id")
);

ALTER TABLE "facility_documents" ADD CONSTRAINT "facility_documents_size_bytes_range" CHECK ("size_bytes" BETWEEN 1 AND 10485760);
ALTER TABLE "facility_documents" ADD CONSTRAINT "facility_documents_file_name_length" CHECK (char_length("file_name") BETWEEN 1 AND 255);
-- 문서는 종류마다 하나 — 바꾸면 옛 행을 지움 표시하고 새 행을 넣는다.
CREATE UNIQUE INDEX "facility_documents_facility_id_document_kind_key" ON "facility_documents" ("facility_id", "document_kind") WHERE NOT "is_deleted";
-- 저장소 키는 행마다 다르다(newKey 의 UUID). 올리기가 실패한 뒤 그 파일을 가리키는 행이 있는지 이 키로 센다.
CREATE UNIQUE INDEX "facility_documents_storage_key_key" ON "facility_documents" ("storage_key");
ALTER TABLE "facility_documents" ADD CONSTRAINT "facility_documents_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities" ("facility_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "facility_documents" ADD CONSTRAINT "facility_documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON TABLE "facility_documents" IS '시설물·장비 문서';
COMMENT ON COLUMN "facility_documents"."facility_document_id" IS '문서 ID';
COMMENT ON COLUMN "facility_documents"."facility_id" IS '시설물·장비 — facilities FK';
COMMENT ON COLUMN "facility_documents"."document_kind" IS '문서 종류 — 사용 매뉴얼 · 주의사항 · 제품 보증서. 지우지 않은 행은 종류마다 하나';
COMMENT ON COLUMN "facility_documents"."file_name" IS '파일 이름';
COMMENT ON COLUMN "facility_documents"."file_type" IS '파일 종류 — JPG · PNG · PDF, 파일 내용으로 확인';
COMMENT ON COLUMN "facility_documents"."size_bytes" IS '파일 크기 — 10MB 이하';
COMMENT ON COLUMN "facility_documents"."storage_key" IS '저장 위치 — 공개 주소 아님 — 저장소 키(facilities/{facility_id}/…)';
COMMENT ON COLUMN "facility_documents"."is_deleted" IS '삭제 여부 — 바꾸거나 빼면 지움 표시, 파일은 남긴다';
COMMENT ON COLUMN "facility_documents"."created_at" IS '등록 일시';
COMMENT ON COLUMN "facility_documents"."created_by" IS '올린 관리자 — admin_accounts FK';

-- 공통코드 그룹 4 · 상세 코드 13(플랫폼 원본, BP000000). 그룹 순서는 지금 있는 그룹(마지막 MINIMUM_WAGE) 뒤.
INSERT INTO "code_groups" ("group_code", "group_name", "manage_owner_code", "is_bp_applied", "status", "sort_order")
SELECT v."group_code", v."group_name", v."manage_owner_code", false, 'ACTIVE',
       (SELECT COALESCE(max("sort_order"), 0) FROM "code_groups") + v."n"
  FROM (VALUES
    ('FACILITY_STATUS', '시설물 운영상태', 'PLATFORM_FIXED', 1),
    ('STORE_FACILITY', '점포 시설물', 'PLATFORM_PROVIDED', 2),
    ('STORE_EQUIPMENT', '점포 장비', 'PLATFORM_PROVIDED', 3),
    ('INSPECTION_CYCLE', '시설물 점검 주기', 'PLATFORM_PROVIDED', 4)
  ) AS v("group_code", "group_name", "manage_owner_code", "n");

INSERT INTO "code_items" ("group_code", "item_code", "bp_code", "label", "manage_owner_code", "status", "sort_order") VALUES
  ('FACILITY_STATUS', 'OPERATING', 'BP000000', '운영', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('FACILITY_STATUS', 'STORED', 'BP000000', '보관', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('FACILITY_STATUS', 'DISPOSED', 'BP000000', '폐기', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('STORE_FACILITY', 'FOOD_STORAGE', 'BP000000', '식재보관', 'PLATFORM_PROVIDED', 'ACTIVE', 1),
  ('STORE_FACILITY', 'WATER_SUPPLY', 'BP000000', '급수', 'PLATFORM_PROVIDED', 'ACTIVE', 2),
  ('STORE_FACILITY', 'HVAC', 'BP000000', '냉난방', 'PLATFORM_PROVIDED', 'ACTIVE', 3),
  ('STORE_EQUIPMENT', 'GRINDER', 'BP000000', '그라인더', 'PLATFORM_PROVIDED', 'ACTIVE', 1),
  ('STORE_EQUIPMENT', 'COFFEE_MACHINE', 'BP000000', '커피머신', 'PLATFORM_PROVIDED', 'ACTIVE', 2),
  ('STORE_EQUIPMENT', 'ICE_MAKER', 'BP000000', '제빙기', 'PLATFORM_PROVIDED', 'ACTIVE', 3),
  ('INSPECTION_CYCLE', 'DAILY', 'BP000000', '매일', 'PLATFORM_PROVIDED', 'ACTIVE', 1),
  ('INSPECTION_CYCLE', 'WEEKLY', 'BP000000', '매주', 'PLATFORM_PROVIDED', 'ACTIVE', 2),
  ('INSPECTION_CYCLE', 'MONTHLY', 'BP000000', '매월', 'PLATFORM_PROVIDED', 'ACTIVE', 3),
  ('INSPECTION_CYCLE', 'AS_NEEDED', 'BP000000', '수시', 'PLATFORM_PROVIDED', 'ACTIVE', 4);

-- 메뉴: url 을 한 단계로, 사용으로.
UPDATE "menus" SET "url" = '/facilities', "status" = 'ACTIVE', "updated_at" = CURRENT_TIMESTAMP
 WHERE "menu_code" = 'MN000022' AND NOT "is_deleted";

-- 고정 권한 그룹 BM000001 · FM000001 에 이 메뉴의 조회 · 등록 · 수정 · 삭제.
INSERT INTO "role_group_menus" ("role_group_id", "menu_id", "is_readable", "is_creatable", "is_updatable", "is_deletable")
SELECT rg."role_group_id", m."menu_id", true, true, true, true
  FROM "role_groups" rg, "menus" m
 WHERE rg."role_code" IN ('BM000001', 'FM000001') AND NOT rg."is_deleted"
   AND m."menu_code" = 'MN000022' AND NOT m."is_deleted"
ON CONFLICT ("role_group_id", "menu_id") DO UPDATE
   SET "is_readable" = true, "is_creatable" = true, "is_updatable" = true, "is_deletable" = true,
       "is_deleted" = false, "updated_at" = CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF (SELECT count(*) FROM "code_groups" WHERE "group_code" IN
        ('FACILITY_STATUS', 'STORE_FACILITY', 'STORE_EQUIPMENT', 'INSPECTION_CYCLE')) <> 4 THEN
    RAISE EXCEPTION '시설물 공통코드 그룹 4건이 들어가지 않았다';
  END IF;
  IF (SELECT count(*) FROM "code_items" WHERE "bp_code" = 'BP000000' AND "group_code" IN
        ('FACILITY_STATUS', 'STORE_FACILITY', 'STORE_EQUIPMENT', 'INSPECTION_CYCLE')) <> 13 THEN
    RAISE EXCEPTION '시설물 공통코드 상세 13건이 들어가지 않았다';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "menus" WHERE "menu_code" = 'MN000022' AND "url" = '/facilities'
                    AND "status" = 'ACTIVE' AND NOT "is_deleted") THEN
    RAISE EXCEPTION '메뉴 MN000022 가 /facilities 사용으로 바뀌지 않았다';
  END IF;
  -- 같거나 한쪽이 다른 쪽 아래인 사용 중 url 이면 관리자 웹의 접두어 판정이 한 메뉴의 권한으로 다른 화면을 연다.
  IF EXISTS (SELECT 1 FROM "menus" a JOIN "menus" b ON a."menu_id" <> b."menu_id"
              WHERE NOT a."is_deleted" AND NOT b."is_deleted" AND a."status" = 'ACTIVE' AND b."status" = 'ACTIVE'
                AND (a."url" = b."url" OR b."url" LIKE a."url" || '/%')
                AND (a."menu_code" = 'MN000022' OR b."menu_code" = 'MN000022')) THEN
    RAISE EXCEPTION '/facilities 와 겹치는 사용 중 메뉴 url 이 있다';
  END IF;
  IF (SELECT count(*) FROM "role_group_menus" x JOIN "role_groups" rg USING ("role_group_id") JOIN "menus" m USING ("menu_id")
       WHERE m."menu_code" = 'MN000022' AND rg."role_code" IN ('BM000001', 'FM000001')
         AND NOT x."is_deleted" AND x."is_readable" AND x."is_creatable" AND x."is_updatable" AND x."is_deletable") <> 2 THEN
    RAISE EXCEPTION 'BM000001 · FM000001 의 시설물 메뉴 권한이 들어가지 않았다';
  END IF;
END $$;
