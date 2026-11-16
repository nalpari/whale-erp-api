-- 시설물·장비 문서 종류를 DB enum 에서 공통코드로 (WHALEERP-718, 2026-11-16 사용자 결정).
--
-- 문서 종류(사용 매뉴얼 · 주의사항 · 제품 보증서)가 enum facility_document_kind 에 고정돼 있어 종류를 더하거나 이름을
-- 바꾸려면 마이그레이션 · 배포가 필요했다. 운영상태 FACILITY_STATUS 처럼 플랫폼고정 공통코드 그룹 FACILITY_DOCUMENT
-- (시설물 문서 종류)로 옮겨, 플랫폼 관리자가 공통코드 관리에서 등록 · 이름 변경 · 순서 변경 · 사용 중지한다. 모든 BP 가
-- 플랫폼 원본(BP000000) 한 벌을 쓰므로 BP 에 복사하지 않는다 — BP 적용이 없어 문서 종류가 빈 BP 가 생기지 않는다.
--   - 그룹 코드는 일감의 예 FACILITY_DOCUMENT_KIND(22자)가 아니다 — 그룹 코드는 20자까지다(code_groups_group_code_format).
--   - 상세 코드는 enum 값 그대로(USER_MANUAL · PRECAUTION · WARRANTY)라 기존 행 · 화면 경로(/documents/:kind)가 그대로 맞는다.
--   - 컬럼 document_kind 는 이름을 두고 TEXT 로 바꾼다 — API 필드 documentKind 를 그대로 두기로 했다(사용자 결정).
--     공통코드 값 컬럼의 이름 규칙({그룹 코드 소문자}_code)과 다른 예외다. 외래키는 없다(공통코드 값 컬럼과 같다).
--   - 「종류마다 1개」 부분 고유 인덱스 facility_documents_facility_id_document_kind_key 는 타입을 바꿀 때 PostgreSQL 이
--     다시 만든다. 이름 · 조건(WHERE NOT is_deleted)은 그대로다.
--   - 값 모양은 상세 코드와 같은 CHECK 로 묶는다(code_items_item_code_format 과 같은 식). 공통코드에 있는지는 api 가 본다.
--
-- enum 을 지우므로 GET /enums 에서 FacilityDocumentKind 가 빠진다 — api 는 pnpm enums:generate 로 다시 만들고, 관리자 웹은
-- 문서 종류를 공통코드 조회로 받아야 한다(이 api 와 함께 배포).

INSERT INTO "code_groups" ("group_code", "group_name", "manage_owner_code", "is_bp_applied", "status", "sort_order")
SELECT 'FACILITY_DOCUMENT', '시설물 문서 종류', 'PLATFORM_FIXED', false, 'ACTIVE',
       (SELECT COALESCE(max("sort_order"), 0) FROM "code_groups") + 1;

INSERT INTO "code_items" ("group_code", "item_code", "bp_code", "label", "manage_owner_code", "status", "sort_order") VALUES
  ('FACILITY_DOCUMENT', 'USER_MANUAL', 'BP000000', '사용 매뉴얼', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('FACILITY_DOCUMENT', 'PRECAUTION', 'BP000000', '주의사항', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('FACILITY_DOCUMENT', 'WARRANTY', 'BP000000', '제품 보증서', 'PLATFORM_FIXED', 'ACTIVE', 3);

ALTER TABLE "facility_documents" ALTER COLUMN "document_kind" TYPE TEXT USING "document_kind"::text;
DROP TYPE "facility_document_kind";

ALTER TABLE "facility_documents" ADD CONSTRAINT "facility_documents_document_kind_format"
  CHECK ("document_kind" ~ '^[A-Z][A-Z0-9_]{0,19}$');

COMMENT ON COLUMN "facility_documents"."document_kind" IS '문서 종류 — 공통코드 FACILITY_DOCUMENT(플랫폼고정)의 상세 코드. 지우지 않은 행은 종류마다 하나';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "code_groups" WHERE "group_code" = 'FACILITY_DOCUMENT'
                    AND "manage_owner_code" = 'PLATFORM_FIXED' AND "status" = 'ACTIVE' AND NOT "is_deleted") THEN
    RAISE EXCEPTION '공통코드 그룹 FACILITY_DOCUMENT(플랫폼고정)가 들어가지 않았다';
  END IF;
  IF (SELECT count(*) FROM "code_items" WHERE "group_code" = 'FACILITY_DOCUMENT' AND "bp_code" = 'BP000000'
        AND "item_code" IN ('USER_MANUAL', 'PRECAUTION', 'WARRANTY') AND "status" = 'ACTIVE' AND NOT "is_deleted") <> 3 THEN
    RAISE EXCEPTION '문서 종류 상세 코드 3건이 들어가지 않았다';
  END IF;
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_name = 'facility_documents' AND column_name = 'document_kind') <> 'text' THEN
    RAISE EXCEPTION 'facility_documents.document_kind 가 TEXT 로 바뀌지 않았다';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'facility_document_kind') THEN
    RAISE EXCEPTION 'enum facility_document_kind 가 남았다';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'facility_documents_facility_id_document_kind_key'
                    AND indexdef LIKE '%WHERE (NOT is_deleted)%') THEN
    RAISE EXCEPTION '「종류마다 1개」 부분 고유 인덱스가 없다';
  END IF;
  -- 지금 있는 문서는 모두 공통코드의 종류여야 한다 — enum 값이 그대로 상세 코드다.
  IF EXISTS (SELECT 1 FROM "facility_documents" d
              WHERE NOT EXISTS (SELECT 1 FROM "code_items" c WHERE c."group_code" = 'FACILITY_DOCUMENT'
                                  AND c."bp_code" = 'BP000000' AND c."item_code" = d."document_kind")) THEN
    RAISE EXCEPTION '공통코드에 없는 문서 종류의 행이 있다';
  END IF;
END $$;
