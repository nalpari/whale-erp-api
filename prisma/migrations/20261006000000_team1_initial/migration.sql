-- 1팀 1차 범위(인증 · BP · 점포 · 시스템 설정) 27 테이블.
--
-- 원본은 whale-erp-new-front 의 docs/erd/team1/schema.sql 이고, 그 저장소의
-- _build_physical.py 가 ERD 카탈로그에서 만든다. 여기 있는 사본이 이 DB 의 진실이다.
--
-- 적용된 마이그레이션은 고치지 않는다. ERD 가 바뀌면 이 파일을 다시 만들지 말고
-- 다음 마이그레이션을 새로 쓴다 — 이미 돌아간 DB 에는 이 파일이 다시 적용되지 않는다.
--
-- Prisma 스키마 언어로 표현되지 않아 이 파일에만 있는 것:
--   CHECK 제약 32개, 부분 고유 인덱스 5개(WHERE · NULLS NOT DISTINCT).
-- db:pull 은 둘 다 schema.prisma 로 가져오지 못한다. 제약을 바꾸려면 여기에 쓴다.
--
-- 외래키는 모두 ON DELETE RESTRICT 다 — 삭제는 is_deleted 논리 삭제로 한다.
-- 3팀 테이블(accounts · staff_members 등)이 들고 있는 store_id · bp_code_id ·
-- admin_account_id 의 외래키는 이 파일에 없다. 3팀 마이그레이션에서 함께 건다.

-- ── enum ──
CREATE TYPE "temporary_password_purpose" AS ENUM ('TEMPORARY', 'INITIAL', 'RESET');  -- 임시비밀번호 · 초기비밀번호 · 비밀번호초기화
CREATE TYPE "login_failure_reason" AS ENUM ('PASSWORD_MISMATCH', 'LOCKED', 'INACTIVE', 'WITHDRAWN');  -- 불일치 · 잠금 · 미사용 · 탈퇴
CREATE TYPE "terms_agreement_channel" AS ENUM ('SIGNUP', 'FIRST_LOGIN', 'REAGREEMENT', 'TERMS_CHANGED');  -- 회원가입 · 최초 로그인 · 재동의 · 약관변경
CREATE TYPE "process_result" AS ENUM ('SUCCEEDED', 'FAILED');  -- 성공 · 실패
CREATE TYPE "use_status" AS ENUM ('ACTIVE', 'INACTIVE');  -- 사용 · 사용중지
CREATE TYPE "repeat_end_type" AS ENUM ('NONE', 'UNTIL_DATE', 'COUNT');  -- 없음 · 날짜 · 횟수
CREATE TYPE "store_image_file_type" AS ENUM ('JPG', 'PNG');  -- JPG · PNG
CREATE TYPE "public_holiday_source" AS ENUM ('RULE', 'PUBLIC_API');  -- 규칙 계산 · 공식 API

-- 약관 버전
CREATE TABLE "terms_versions" (
    "terms_version_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "terms_type_code" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "terms_versions_pkey" PRIMARY KEY ("terms_version_id")
);

-- BP 코드
CREATE TABLE "bp_codes" (
    "bp_code_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "bp_code" TEXT NOT NULL,
    "is_platform" BOOLEAN NOT NULL DEFAULT false,
    "account_status_code" TEXT NOT NULL,
    "trade_name" TEXT NOT NULL,
    "biz_registration_number" TEXT,
    "biz_ceo_name" TEXT,
    "biz_open_date" DATE,
    "biz_ceo_phone" TEXT,
    "biz_ceo_email" TEXT,
    "biz_zip_code" TEXT,
    "biz_address" TEXT,
    "biz_address_detail" TEXT,
    "biz_category" TEXT,
    "biz_item" TEXT,
    "biz_verified_at" TIMESTAMPTZ(6),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "bp_codes_pkey" PRIMARY KEY ("bp_code_id")
);

-- 관리자 계정
CREATE TABLE "admin_accounts" (
    "admin_account_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "login_id" TEXT NOT NULL,
    "bp_code_id" INTEGER NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "role_type_code" TEXT NOT NULL,
    "role_group_id" INTEGER NOT NULL,
    "terms_of_use_version_id" INTEGER,
    "terms_of_use_agreed_at" TIMESTAMPTZ(6),
    "privacy_version_id" INTEGER,
    "privacy_agreed_at" TIMESTAMPTZ(6),
    "terms_agreed_at" TIMESTAMPTZ(6),
    "is_password_change_required" BOOLEAN NOT NULL DEFAULT false,
    "is_initial_password_unsent" BOOLEAN NOT NULL DEFAULT false,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "lock_expires_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "join_path_code" TEXT NOT NULL,
    "is_all_stores" BOOLEAN NOT NULL DEFAULT false,
    "department" TEXT,
    "job_title" TEXT,
    "zip_code" TEXT,
    "address" TEXT,
    "address_detail" TEXT,
    "withdraw_reason_code" TEXT,
    "withdraw_reason_detail" TEXT,
    "account_status_code" TEXT NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "admin_accounts_pkey" PRIMARY KEY ("admin_account_id")
);

-- 관리자 접속 상태
CREATE TABLE "admin_sessions" (
    "session_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "admin_account_id" INTEGER NOT NULL,
    "device_information" TEXT,
    "access_token_hash" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "refresh_last_used_at" TIMESTAMPTZ(6) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("session_id")
);

-- 임시 비밀번호
CREATE TABLE "temporary_passwords" (
    "temporary_password_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "admin_account_id" INTEGER NOT NULL,
    "password_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "invalidated_at" TIMESTAMPTZ(6),
    "purpose" "temporary_password_purpose" NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "temporary_passwords_pkey" PRIMARY KEY ("temporary_password_id")
);

-- 관리자 로그인 이력
CREATE TABLE "admin_login_logs" (
    "login_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "admin_account_id" INTEGER,
    "client_address" TEXT,
    "is_succeeded" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" "login_failure_reason",
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_login_logs_pkey" PRIMARY KEY ("login_id")
);

-- 관리자 변경 이력
CREATE TABLE "admin_change_histories" (
    "change_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "admin_account_id" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "changed_by" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_change_histories_pkey" PRIMARY KEY ("change_id")
);

-- 약관 동의 이력
CREATE TABLE "terms_agreement_logs" (
    "agreement_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "admin_account_id" INTEGER NOT NULL,
    "terms_version_id" INTEGER NOT NULL,
    "is_agreed" BOOLEAN NOT NULL DEFAULT false,
    "agreed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" "terms_agreement_channel" NOT NULL,
    "client_address" TEXT,

    CONSTRAINT "terms_agreement_logs_pkey" PRIMARY KEY ("agreement_id")
);

-- 메일 발송 이력
CREATE TABLE "mail_send_logs" (
    "mail_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "mail_type_code" TEXT NOT NULL,
    "admin_account_id" INTEGER,
    "from_email" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "result" "process_result" NOT NULL,
    "failure_reason" TEXT,
    "sent_by" INTEGER,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_send_logs_pkey" PRIMARY KEY ("mail_id")
);

-- 점포
CREATE TABLE "stores" (
    "store_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "store_code" TEXT NOT NULL,
    "bp_code_id" INTEGER NOT NULL,
    "store_type_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "zip_code" TEXT,
    "address" TEXT,
    "address_detail" TEXT,
    "latitude" NUMERIC(8,6),
    "longitude" NUMERIC(9,6),
    "is_location_applied" BOOLEAN NOT NULL DEFAULT true,
    "closed_date" DATE,
    "store_status_code" TEXT NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("store_id")
);

-- 점포 층별정보
CREATE TABLE "store_floors" (
    "store_floor_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "store_id" INTEGER NOT NULL,
    "floor_area_pyeong" NUMERIC(8,1),
    "floor_area_sqm" NUMERIC(10,2),
    "seat_count" INTEGER,
    "floor_type_code" TEXT,
    "floor_number" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "store_floors_pkey" PRIMARY KEY ("store_floor_id")
);

-- 점포 대표 이미지 파일
CREATE TABLE "store_image_files" (
    "file_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "store_id" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" "store_image_file_type" NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "store_image_files_pkey" PRIMARY KEY ("file_id")
);

-- 점포 사업자정보
CREATE TABLE "store_business_profiles" (
    "store_id" INTEGER NOT NULL,
    "biz_trade_name" TEXT,
    "biz_registration_number" TEXT,
    "biz_ceo_name" TEXT,
    "biz_open_date" DATE,
    "biz_ceo_phone" TEXT,
    "biz_zip_code" TEXT,
    "biz_address" TEXT,
    "biz_address_detail" TEXT,
    "biz_category" TEXT,
    "biz_item" TEXT,
    "biz_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "store_business_profiles_pkey" PRIMARY KEY ("store_id")
);

-- 점포 변경 이력
CREATE TABLE "store_change_histories" (
    "change_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "store_id" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "changed_by" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retain_end_date" DATE NOT NULL,

    CONSTRAINT "store_change_histories_pkey" PRIMARY KEY ("change_id")
);

-- 관리자 점포 매핑
CREATE TABLE "admin_store_mappings" (
    "admin_account_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "admin_store_mappings_pkey" PRIMARY KEY ("admin_account_id", "store_id")
);

-- BP 변경 이력
CREATE TABLE "bp_change_histories" (
    "change_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "bp_code_id" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "changed_by" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "bp_change_histories_pkey" PRIMARY KEY ("change_id")
);

-- 권한 그룹
CREATE TABLE "role_groups" (
    "role_group_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "role_code" TEXT NOT NULL,
    "bp_code_id" INTEGER NOT NULL,
    "role_type_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_master" BOOLEAN NOT NULL DEFAULT false,
    "manager_admin_account_id" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "role_groups_pkey" PRIMARY KEY ("role_group_id")
);

-- 권한 메뉴
CREATE TABLE "role_group_menus" (
    "role_group_id" INTEGER NOT NULL,
    "menu_id" INTEGER NOT NULL,
    "is_readable" BOOLEAN NOT NULL DEFAULT false,
    "is_creatable" BOOLEAN NOT NULL DEFAULT false,
    "is_updatable" BOOLEAN NOT NULL DEFAULT false,
    "is_deletable" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "role_group_menus_pkey" PRIMARY KEY ("role_group_id", "menu_id")
);

-- 공통코드 그룹
CREATE TABLE "code_groups" (
    "group_code" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "manage_owner_code" TEXT NOT NULL,
    "is_bp_applied" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "status" "use_status" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "code_groups_pkey" PRIMARY KEY ("group_code")
);

-- 상세 코드
CREATE TABLE "code_items" (
    "group_code" TEXT NOT NULL,
    "item_code" TEXT NOT NULL,
    "bp_code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "manage_owner_code" TEXT NOT NULL,
    "status" "use_status" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "code_items_pkey" PRIMARY KEY ("group_code", "item_code", "bp_code")
);

-- 메뉴
CREATE TABLE "menus" (
    "menu_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "menu_code" TEXT NOT NULL,
    "service_code" TEXT NOT NULL,
    "parent_menu_id" INTEGER,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL,
    "status" "use_status" NOT NULL DEFAULT 'ACTIVE',
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("menu_id")
);

-- BP 휴일
CREATE TABLE "bp_holidays" (
    "bp_holiday_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "bp_code_id" INTEGER NOT NULL,
    "is_all_stores" BOOLEAN NOT NULL DEFAULT false,
    "holiday_type_code" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "holiday_repeat_type_code" TEXT,
    "repeat_end_type" "repeat_end_type",
    "repeat_end_date" DATE,
    "repeat_count" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "origin_bp_holiday_id" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "bp_holidays_pkey" PRIMARY KEY ("bp_holiday_id")
);

-- 휴일 점포 매핑
CREATE TABLE "holiday_store_mappings" (
    "bp_holiday_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "effective_end_date" DATE,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "holiday_store_mappings_pkey" PRIMARY KEY ("bp_holiday_id", "store_id")
);

-- 휴일 예외 점포
CREATE TABLE "holiday_excluded_stores" (
    "bp_holiday_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "effective_start_date" DATE NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "holiday_excluded_stores_pkey" PRIMARY KEY ("bp_holiday_id", "store_id")
);

-- BP 휴일 변경 이력
CREATE TABLE "bp_holiday_change_histories" (
    "change_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "bp_holiday_id" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "changed_by" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bp_holiday_change_histories_pkey" PRIMARY KEY ("change_id")
);

-- 플랫폼 공식 휴일
CREATE TABLE "public_holidays" (
    "public_holiday_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "holiday_date" DATE NOT NULL,
    "year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "source" "public_holiday_source" NOT NULL,
    "source_ref" TEXT,
    "synchronized_at" TIMESTAMPTZ(6),

    CONSTRAINT "public_holidays_pkey" PRIMARY KEY ("public_holiday_id")
);

-- 동기화 이력
CREATE TABLE "public_holiday_synchronization_logs" (
    "synchronization_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "year" INTEGER NOT NULL,
    "synchronized_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "deleted_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "result" "process_result" NOT NULL,

    CONSTRAINT "public_holiday_synchronization_logs_pkey" PRIMARY KEY ("synchronization_id")
);

-- ── CHECK 제약 ──
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_bp_code_format" CHECK ("bp_code" ~ '^BP[0-9]{6}$');
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_trade_name_length" CHECK (char_length("trade_name") BETWEEN 1 AND 50);
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_biz_category_length" CHECK (char_length("biz_category") <= 50);
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_biz_item_length" CHECK (char_length("biz_item") <= 50);
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_login_id_format" CHECK ("login_id" ~ '^[A-Za-z0-9]{4,20}$');
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_name_length" CHECK (char_length("name") BETWEEN 2 AND 20);
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_phone_format" CHECK ("phone" ~ '^[0-9]{10,11}$');
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_email_lower" CHECK ("email" = lower("email"));
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_withdraw_reason_detail_length" CHECK (char_length("withdraw_reason_detail") <= 500);
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_failed_login_count_nonnegative" CHECK ("failed_login_count" >= 0);
ALTER TABLE "stores" ADD CONSTRAINT "stores_store_code_format" CHECK ("store_code" ~ '^ST[0-9]{6}$');
ALTER TABLE "stores" ADD CONSTRAINT "stores_name_length" CHECK (char_length("name") BETWEEN 1 AND 50);
ALTER TABLE "stores" ADD CONSTRAINT "stores_phone_format" CHECK ("phone" ~ '^[0-9]{9,11}$');
ALTER TABLE "stores" ADD CONSTRAINT "stores_latitude_range" CHECK ("latitude" BETWEEN -90 AND 90);
ALTER TABLE "stores" ADD CONSTRAINT "stores_longitude_range" CHECK ("longitude" BETWEEN -180 AND 180);
ALTER TABLE "store_floors" ADD CONSTRAINT "store_floors_seat_count_nonnegative" CHECK ("seat_count" >= 0);
ALTER TABLE "store_floors" ADD CONSTRAINT "store_floors_floor_area_pyeong_nonnegative" CHECK ("floor_area_pyeong" >= 0);
ALTER TABLE "store_floors" ADD CONSTRAINT "store_floors_floor_area_sqm_nonnegative" CHECK ("floor_area_sqm" >= 0);
ALTER TABLE "store_image_files" ADD CONSTRAINT "store_image_files_size_bytes_range" CHECK ("size_bytes" BETWEEN 1 AND 5242880);
ALTER TABLE "store_business_profiles" ADD CONSTRAINT "store_business_profiles_biz_ceo_phone_format" CHECK ("biz_ceo_phone" ~ '^[0-9]{10,11}$');
ALTER TABLE "store_business_profiles" ADD CONSTRAINT "store_business_profiles_biz_category_length" CHECK (char_length("biz_category") <= 50);
ALTER TABLE "store_business_profiles" ADD CONSTRAINT "store_business_profiles_biz_item_length" CHECK (char_length("biz_item") <= 50);
ALTER TABLE "role_groups" ADD CONSTRAINT "role_groups_role_code_format" CHECK ("role_code" ~ '^[A-Z]{2}[0-9]{6}$');
ALTER TABLE "code_groups" ADD CONSTRAINT "code_groups_group_code_format" CHECK ("group_code" ~ '^[A-Z][A-Z0-9_]{0,19}$');
ALTER TABLE "code_items" ADD CONSTRAINT "code_items_item_code_format" CHECK ("item_code" ~ '^[A-Z][A-Z0-9_]{0,19}$');
ALTER TABLE "menus" ADD CONSTRAINT "menus_menu_code_format" CHECK ("menu_code" ~ '^MN[0-9]{6}$');
ALTER TABLE "menus" ADD CONSTRAINT "menus_depth_range" CHECK ("depth" BETWEEN 1 AND 3);
ALTER TABLE "bp_holidays" ADD CONSTRAINT "bp_holidays_name_length" CHECK (char_length("name") BETWEEN 1 AND 30);
ALTER TABLE "bp_holidays" ADD CONSTRAINT "bp_holidays_end_date_after_start" CHECK ("end_date" >= "start_date");
ALTER TABLE "bp_holidays" ADD CONSTRAINT "bp_holidays_repeat_count_positive" CHECK ("repeat_count" > 0);
ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_year_range" CHECK ("year" BETWEEN 2000 AND 2100);
ALTER TABLE "public_holiday_synchronization_logs" ADD CONSTRAINT "public_holiday_synchronization_logs_counts_nonnegative" CHECK ("created_count" >= 0 AND "updated_count" >= 0 AND "deleted_count" >= 0 AND "failed_count" >= 0);

-- ── 고유 제약 ──
CREATE UNIQUE INDEX "bp_codes_bp_code_key" ON "bp_codes" ("bp_code");  -- BP 코드 고유
CREATE UNIQUE INDEX "bp_codes_is_platform_key" ON "bp_codes" ("is_platform") WHERE "is_platform";  -- 플랫폼 BP 는 한 행만
CREATE UNIQUE INDEX "bp_codes_biz_registration_number_key" ON "bp_codes" ("biz_registration_number") WHERE "is_platform" = false AND "is_deleted" = false AND "account_status_code" <> 'WITHDRAWN';  -- 탈퇴·삭제되지 않은 고객 BP 끼리 고유 — ACCOUNT_STATUS 의 탈퇴 코드 값이 정해지면 조건을 맞춘다
CREATE UNIQUE INDEX "admin_accounts_login_id_key" ON "admin_accounts" ("login_id");  -- 탈퇴·삭제 포함 고유
CREATE UNIQUE INDEX "admin_accounts_email_key" ON "admin_accounts" ("email") WHERE "is_deleted" = false AND "account_status_code" <> 'WITHDRAWN';  -- 사용·미사용 계정 간 고유 — 탈퇴 코드 값이 정해지면 조건을 맞춘다
CREATE UNIQUE INDEX "terms_versions_terms_type_code_version_key" ON "terms_versions" ("terms_type_code", "version");  -- 약관 유형별 버전 고유
CREATE UNIQUE INDEX "stores_store_code_key" ON "stores" ("store_code");  -- 점포코드 고유
CREATE UNIQUE INDEX "store_image_files_store_id_key" ON "store_image_files" ("store_id") WHERE "is_deleted" = false;  -- 삭제되지 않은 대표 이미지는 점포당 하나
CREATE UNIQUE INDEX "role_groups_role_code_key" ON "role_groups" ("role_code");  -- 권한 코드 고유
CREATE UNIQUE INDEX "menus_menu_code_key" ON "menus" ("menu_code");  -- 메뉴 코드 고유
CREATE UNIQUE INDEX "public_holidays_holiday_date_key" ON "public_holidays" ("holiday_date");  -- 한 날짜에 한 건
CREATE UNIQUE INDEX "role_groups_bp_code_id_manager_admin_account_id_name_key" ON "role_groups" ("bp_code_id", "manager_admin_account_id", "name") NULLS NOT DISTINCT WHERE "is_deleted" = false;  -- 같은 BP·같은 관리계정ID 안 권한명 고유. 관리계정이 없는 그룹끼리도 겹치지 않게 NULLS NOT DISTINCT

-- ── 외래키 (모두 ON DELETE RESTRICT — 삭제는 논리 삭제다) ──
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_role_group_id_fkey" FOREIGN KEY ("role_group_id") REFERENCES "role_groups" ("role_group_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_terms_of_use_version_id_fkey" FOREIGN KEY ("terms_of_use_version_id") REFERENCES "terms_versions" ("terms_version_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_privacy_version_id_fkey" FOREIGN KEY ("privacy_version_id") REFERENCES "terms_versions" ("terms_version_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "temporary_passwords" ADD CONSTRAINT "temporary_passwords_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "temporary_passwords" ADD CONSTRAINT "temporary_passwords_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "temporary_passwords" ADD CONSTRAINT "temporary_passwords_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_login_logs" ADD CONSTRAINT "admin_login_logs_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_change_histories" ADD CONSTRAINT "admin_change_histories_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_change_histories" ADD CONSTRAINT "admin_change_histories_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "terms_agreement_logs" ADD CONSTRAINT "terms_agreement_logs_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "terms_agreement_logs" ADD CONSTRAINT "terms_agreement_logs_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "terms_versions" ("terms_version_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "mail_send_logs" ADD CONSTRAINT "mail_send_logs_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "mail_send_logs" ADD CONSTRAINT "mail_send_logs_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "stores" ADD CONSTRAINT "stores_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "stores" ADD CONSTRAINT "stores_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "stores" ADD CONSTRAINT "stores_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_floors" ADD CONSTRAINT "store_floors_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_floors" ADD CONSTRAINT "store_floors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_floors" ADD CONSTRAINT "store_floors_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_image_files" ADD CONSTRAINT "store_image_files_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_image_files" ADD CONSTRAINT "store_image_files_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_image_files" ADD CONSTRAINT "store_image_files_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_business_profiles" ADD CONSTRAINT "store_business_profiles_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_business_profiles" ADD CONSTRAINT "store_business_profiles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_business_profiles" ADD CONSTRAINT "store_business_profiles_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_change_histories" ADD CONSTRAINT "store_change_histories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "store_change_histories" ADD CONSTRAINT "store_change_histories_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_store_mappings" ADD CONSTRAINT "admin_store_mappings_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_store_mappings" ADD CONSTRAINT "admin_store_mappings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_store_mappings" ADD CONSTRAINT "admin_store_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "admin_store_mappings" ADD CONSTRAINT "admin_store_mappings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_change_histories" ADD CONSTRAINT "bp_change_histories_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_change_histories" ADD CONSTRAINT "bp_change_histories_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_groups" ADD CONSTRAINT "role_groups_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_groups" ADD CONSTRAINT "role_groups_manager_admin_account_id_fkey" FOREIGN KEY ("manager_admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_groups" ADD CONSTRAINT "role_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_groups" ADD CONSTRAINT "role_groups_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_group_menus" ADD CONSTRAINT "role_group_menus_role_group_id_fkey" FOREIGN KEY ("role_group_id") REFERENCES "role_groups" ("role_group_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_group_menus" ADD CONSTRAINT "role_group_menus_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menus" ("menu_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_group_menus" ADD CONSTRAINT "role_group_menus_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "role_group_menus" ADD CONSTRAINT "role_group_menus_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "code_groups" ADD CONSTRAINT "code_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "code_groups" ADD CONSTRAINT "code_groups_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "code_items" ADD CONSTRAINT "code_items_group_code_fkey" FOREIGN KEY ("group_code") REFERENCES "code_groups" ("group_code") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "code_items" ADD CONSTRAINT "code_items_bp_code_fkey" FOREIGN KEY ("bp_code") REFERENCES "bp_codes" ("bp_code") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "code_items" ADD CONSTRAINT "code_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "code_items" ADD CONSTRAINT "code_items_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "menus" ADD CONSTRAINT "menus_parent_menu_id_fkey" FOREIGN KEY ("parent_menu_id") REFERENCES "menus" ("menu_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "menus" ADD CONSTRAINT "menus_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "menus" ADD CONSTRAINT "menus_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_holidays" ADD CONSTRAINT "bp_holidays_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_holidays" ADD CONSTRAINT "bp_holidays_origin_bp_holiday_id_fkey" FOREIGN KEY ("origin_bp_holiday_id") REFERENCES "bp_holidays" ("bp_holiday_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_holidays" ADD CONSTRAINT "bp_holidays_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_holidays" ADD CONSTRAINT "bp_holidays_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_store_mappings" ADD CONSTRAINT "holiday_store_mappings_bp_holiday_id_fkey" FOREIGN KEY ("bp_holiday_id") REFERENCES "bp_holidays" ("bp_holiday_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_store_mappings" ADD CONSTRAINT "holiday_store_mappings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_store_mappings" ADD CONSTRAINT "holiday_store_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_store_mappings" ADD CONSTRAINT "holiday_store_mappings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_excluded_stores" ADD CONSTRAINT "holiday_excluded_stores_bp_holiday_id_fkey" FOREIGN KEY ("bp_holiday_id") REFERENCES "bp_holidays" ("bp_holiday_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_excluded_stores" ADD CONSTRAINT "holiday_excluded_stores_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_excluded_stores" ADD CONSTRAINT "holiday_excluded_stores_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "holiday_excluded_stores" ADD CONSTRAINT "holiday_excluded_stores_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_holiday_change_histories" ADD CONSTRAINT "bp_holiday_change_histories_bp_holiday_id_fkey" FOREIGN KEY ("bp_holiday_id") REFERENCES "bp_holidays" ("bp_holiday_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "bp_holiday_change_histories" ADD CONSTRAINT "bp_holiday_change_histories_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ── 조회 인덱스 ──
CREATE INDEX "admin_accounts_bp_code_id_idx" ON "admin_accounts" ("bp_code_id");
CREATE INDEX "admin_accounts_role_group_id_idx" ON "admin_accounts" ("role_group_id");
CREATE INDEX "admin_sessions_admin_account_id_idx" ON "admin_sessions" ("admin_account_id");
CREATE INDEX "temporary_passwords_admin_account_id_idx" ON "temporary_passwords" ("admin_account_id");
CREATE INDEX "admin_login_logs_admin_account_id_attempted_at_idx" ON "admin_login_logs" ("admin_account_id", "attempted_at");
CREATE INDEX "admin_change_histories_admin_account_id_changed_at_idx" ON "admin_change_histories" ("admin_account_id", "changed_at");
CREATE INDEX "terms_agreement_logs_admin_account_id_idx" ON "terms_agreement_logs" ("admin_account_id");
CREATE INDEX "mail_send_logs_admin_account_id_sent_at_idx" ON "mail_send_logs" ("admin_account_id", "sent_at");
CREATE INDEX "stores_bp_code_id_idx" ON "stores" ("bp_code_id");
CREATE INDEX "store_floors_store_id_idx" ON "store_floors" ("store_id");
CREATE INDEX "store_change_histories_store_id_changed_at_idx" ON "store_change_histories" ("store_id", "changed_at");
CREATE INDEX "admin_store_mappings_store_id_idx" ON "admin_store_mappings" ("store_id");
CREATE INDEX "bp_change_histories_bp_code_id_changed_at_idx" ON "bp_change_histories" ("bp_code_id", "changed_at");
CREATE INDEX "role_group_menus_menu_id_idx" ON "role_group_menus" ("menu_id");
CREATE INDEX "code_items_bp_code_idx" ON "code_items" ("bp_code");
CREATE INDEX "menus_parent_menu_id_idx" ON "menus" ("parent_menu_id");
CREATE INDEX "bp_holidays_bp_code_id_start_date_idx" ON "bp_holidays" ("bp_code_id", "start_date");
CREATE INDEX "holiday_store_mappings_store_id_idx" ON "holiday_store_mappings" ("store_id");
CREATE INDEX "holiday_excluded_stores_store_id_idx" ON "holiday_excluded_stores" ("store_id");
CREATE INDEX "bp_holiday_change_histories_bp_holiday_id_changed_at_idx" ON "bp_holiday_change_histories" ("bp_holiday_id", "changed_at");
CREATE INDEX "public_holidays_year_idx" ON "public_holidays" ("year");

-- ── 주석 ──
COMMENT ON TABLE "terms_versions" IS '약관 버전';
COMMENT ON COLUMN "terms_versions"."terms_version_id" IS '약관 버전 ID';
COMMENT ON COLUMN "terms_versions"."terms_type_code" IS '약관 유형 코드 — 공통코드 `TERMS_TYPE`(`TERMS_SERVICE` 이용약관(BP 회원가입용)·`PRIVACY_COLLECT` 개인정보 수집·이용 동의(BP 회원가입용)·`STAFF_TERMS_SERVICE` 이용약관(직원 앱 회원가입용)·`STAFF_PRIVACY` 개인정보 수집·이용 동의(직원 앱 회원가입용)·`MARKETING` 마케팅 수신 동의·`LOCATION` 위치정보 수집·이용 동의)';
COMMENT ON COLUMN "terms_versions"."version" IS '버전 번호 — 예: v1.0, v1.1';
COMMENT ON COLUMN "terms_versions"."content" IS '약관 내용 — 약관 본문';
COMMENT ON COLUMN "terms_versions"."title" IS '제목';
COMMENT ON COLUMN "terms_versions"."effective_date" IS '시행일';
COMMENT ON COLUMN "terms_versions"."is_active" IS '사용 여부 — 현재 적용 중인 버전';
COMMENT ON COLUMN "terms_versions"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "terms_versions"."created_at" IS '등록 일시';
COMMENT ON COLUMN "terms_versions"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "terms_versions"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "terms_versions"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "bp_codes" IS 'BP 코드';
COMMENT ON COLUMN "bp_codes"."bp_code_id" IS 'BP ID';
COMMENT ON COLUMN "bp_codes"."bp_code" IS 'BP 코드 — BP+6자리, 고유, 자동 채번, 변경 불가. 플랫폼 BP 는 BP000000 예약(채번 제외)';
COMMENT ON COLUMN "bp_codes"."is_platform" IS '플랫폼 BP 여부 — 기본 false. true 인 행은 하나만(부분 유일)';
COMMENT ON COLUMN "bp_codes"."account_status_code" IS 'BP 상태 코드 — 공통코드 `ACCOUNT_STATUS`(사용·미사용·탈퇴), 기본 사용. 시스템만 변경, 플랫폼 BP 는 사용 고정';
COMMENT ON COLUMN "bp_codes"."trade_name" IS '상호명 — 1~50자';
COMMENT ON COLUMN "bp_codes"."biz_registration_number" IS '사업자등록번호 — 탈퇴하지 않은 고객 BP끼리 고유(부분 유일). 플랫폼 BP 는 검사에서 제외';
COMMENT ON COLUMN "bp_codes"."biz_ceo_name" IS '대표자명 — 인증 결과만';
COMMENT ON COLUMN "bp_codes"."biz_open_date" IS '개업일자 — 인증 결과만';
COMMENT ON COLUMN "bp_codes"."biz_ceo_phone" IS '대표자 연락처 — BP 탈퇴 때 삭제(개인정보)';
COMMENT ON COLUMN "bp_codes"."biz_ceo_email" IS '대표자 이메일 — BP 탈퇴 때 삭제(개인정보)';
COMMENT ON COLUMN "bp_codes"."biz_zip_code" IS '사업장 우편번호';
COMMENT ON COLUMN "bp_codes"."biz_address" IS '사업장 기본주소';
COMMENT ON COLUMN "bp_codes"."biz_address_detail" IS '사업장 상세주소';
COMMENT ON COLUMN "bp_codes"."biz_category" IS '업태 — 50자';
COMMENT ON COLUMN "bp_codes"."biz_item" IS '종목 — 50자';
COMMENT ON COLUMN "bp_codes"."biz_verified_at" IS '최종 인증일시';
COMMENT ON COLUMN "bp_codes"."is_deleted" IS '삭제 여부 — 오등록 BP 삭제 때만 true. BP 탈퇴는 바꾸지 않음';
COMMENT ON COLUMN "bp_codes"."created_at" IS '등록 일시';
COMMENT ON COLUMN "bp_codes"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "bp_codes"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "bp_codes"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "admin_accounts" IS '관리자 계정';
COMMENT ON COLUMN "admin_accounts"."admin_account_id" IS '관리자 ID';
COMMENT ON COLUMN "admin_accounts"."login_id" IS '관리자 로그인ID — 영문·숫자 4~20자, 탈퇴·삭제 포함 고유, 변경 불가';
COMMENT ON COLUMN "admin_accounts"."bp_code_id" IS 'BP — bp_codes FK, 필수. 플랫폼 마스터·플랫폼 관리자는 플랫폼 BP';
COMMENT ON COLUMN "admin_accounts"."name" IS '이름 — 한글·영문 2~20자';
COMMENT ON COLUMN "admin_accounts"."password_hash" IS '비밀번호 해시';
COMMENT ON COLUMN "admin_accounts"."phone" IS '연락처 — 숫자 10~11자리';
COMMENT ON COLUMN "admin_accounts"."email" IS '이메일 — 사용·미사용 계정 간 고유';
COMMENT ON COLUMN "admin_accounts"."role_type_code" IS '권한 유형 코드 — 공통코드 `ROLE_TYPE`(플랫폼 마스터·플랫폼 관리자·BP 마스터·BP 관리자·가맹 마스터·가맹 관리자)';
COMMENT ON COLUMN "admin_accounts"."role_group_id" IS '권한 그룹 — 한 명에 하나';
COMMENT ON COLUMN "admin_accounts"."terms_of_use_version_id" IS '이용약관 최근 동의 버전 — terms_versions FK, 동의 전(플랫폼등록 계정 첫 로그인 전)은 비움';
COMMENT ON COLUMN "admin_accounts"."terms_of_use_agreed_at" IS '이용약관 동의 일시';
COMMENT ON COLUMN "admin_accounts"."privacy_version_id" IS '개인정보 최근 동의 버전 — terms_versions FK, 동의 전은 비움';
COMMENT ON COLUMN "admin_accounts"."privacy_agreed_at" IS '개인정보 동의 일시';
COMMENT ON COLUMN "admin_accounts"."terms_agreed_at" IS '약관 최근 동의 일시 — 이용약관과 개인정보 수집·이용 동의한 일시';
COMMENT ON COLUMN "admin_accounts"."is_password_change_required" IS '강제 비밀번호 변경 대상 — 초기·임시 비밀번호 발급 시 true';
COMMENT ON COLUMN "admin_accounts"."is_initial_password_unsent" IS '초기 비밀번호 미발송 — 계정 생성·초기화 메일이 실패하면 true, 다시 보내면 false';
COMMENT ON COLUMN "admin_accounts"."failed_login_count" IS '로그인 실패 횟수 — 5회 잠금';
COMMENT ON COLUMN "admin_accounts"."lock_expires_at" IS '잠금 해제 시각 — 5분 잠금';
COMMENT ON COLUMN "admin_accounts"."last_login_at" IS '최근 로그인 일시';
COMMENT ON COLUMN "admin_accounts"."join_path_code" IS '가입경로 코드 — 공통코드 `JOIN_PATH`(회원가입·플랫폼등록), 모든 계정 필수';
COMMENT ON COLUMN "admin_accounts"."is_all_stores" IS '전체 점포 적용 여부 — true 면 소속 BP 모든 점포(이후 등록 포함)를 관리하고 점포 매핑을 두지 않음. false 면 `admin_store_mappings`. 가맹 마스터는 false 만';
COMMENT ON COLUMN "admin_accounts"."department" IS '소속 부서 — 플랫폼 관리자만, 선택';
COMMENT ON COLUMN "admin_accounts"."job_title" IS '직책 — 플랫폼 관리자만, 선택';
COMMENT ON COLUMN "admin_accounts"."zip_code" IS '우편번호 — 플랫폼 관리자만, 선택';
COMMENT ON COLUMN "admin_accounts"."address" IS '기본주소 — 플랫폼 관리자만, 선택';
COMMENT ON COLUMN "admin_accounts"."address_detail" IS '상세주소 — 플랫폼 관리자만, 선택';
COMMENT ON COLUMN "admin_accounts"."withdraw_reason_code" IS '탈퇴 사유 코드 — 공통코드 `WITHDRAW_REASON`(WD_CLOSE 등 탈퇴 사유)';
COMMENT ON COLUMN "admin_accounts"."withdraw_reason_detail" IS '탈퇴사유설명 — 직접입력 시 500자';
COMMENT ON COLUMN "admin_accounts"."account_status_code" IS '계정 상태 코드 — 공통코드 `ACCOUNT_STATUS`(사용·미사용·탈퇴). BP 마스터 계정은 `bp_codes.account_status_code` 와 같은 트랜잭션에서 함께 바뀐다';
COMMENT ON COLUMN "admin_accounts"."status_changed_at" IS '계정상태변경일시 — 탈퇴 일시도 여기에 남는다. BP 가 탈퇴하면 하위 계정(BP 관리자·가맹 마스터·가맹 관리자)도 같은 순간 탈퇴하고 개인정보를 지운다 — 아이디만 보존';
COMMENT ON COLUMN "admin_accounts"."is_deleted" IS '삭제 여부 — 오등록 삭제용, 논리 삭제. 회원 탈퇴는 바꾸지 않음(상태만 탈퇴)';
COMMENT ON COLUMN "admin_accounts"."created_at" IS '등록 일시';
COMMENT ON COLUMN "admin_accounts"."created_by" IS '등록자 — 플랫폼등록 시 플랫폼 관리자';
COMMENT ON COLUMN "admin_accounts"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "admin_accounts"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "admin_sessions" IS '관리자 접속 상태';
COMMENT ON COLUMN "admin_sessions"."session_id" IS '접속 ID';
COMMENT ON COLUMN "admin_sessions"."admin_account_id" IS '관리자';
COMMENT ON COLUMN "admin_sessions"."device_information" IS '기기 식별 정보 — 여러 브라우저 동시 로그인';
COMMENT ON COLUMN "admin_sessions"."access_token_hash" IS '접근 토큰 해시 — 1시간';
COMMENT ON COLUMN "admin_sessions"."refresh_token_hash" IS '갱신 토큰 해시 — 마지막 사용 후 1시간';
COMMENT ON COLUMN "admin_sessions"."refresh_last_used_at" IS '갱신 토큰 마지막 사용 시각 — 여기서 1시간이 지나면 만료';
COMMENT ON COLUMN "admin_sessions"."issued_at" IS '발급 시각';
COMMENT ON COLUMN "admin_sessions"."expires_at" IS '만료 시각';
COMMENT ON COLUMN "admin_sessions"."revoked_at" IS '종료 시각 — 로그아웃·비밀번호 변경 시';
COMMENT ON COLUMN "admin_sessions"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "admin_sessions"."created_at" IS '등록 일시';
COMMENT ON COLUMN "admin_sessions"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "admin_sessions"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "admin_sessions"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "temporary_passwords" IS '임시 비밀번호';
COMMENT ON COLUMN "temporary_passwords"."temporary_password_id" IS '임시 비밀번호 ID';
COMMENT ON COLUMN "temporary_passwords"."admin_account_id" IS '관리자';
COMMENT ON COLUMN "temporary_passwords"."password_hash" IS '비밀번호 해시 — 12자 무작위';
COMMENT ON COLUMN "temporary_passwords"."issued_at" IS '발급 시각';
COMMENT ON COLUMN "temporary_passwords"."expires_at" IS '만료 시각 — 1시간 — 임시·초기·초기화 모두';
COMMENT ON COLUMN "temporary_passwords"."used_at" IS '사용 시각 — 로그인 성공 시';
COMMENT ON COLUMN "temporary_passwords"."invalidated_at" IS '무효화 시각 — 다시 발급하거나 비밀번호를 바꾸면';
COMMENT ON COLUMN "temporary_passwords"."purpose" IS '발급 용도 — 임시비밀번호·초기비밀번호·비밀번호초기화. 찾기 발급 제한(계정당 1시간 5회)은 임시비밀번호만 센다';
COMMENT ON COLUMN "temporary_passwords"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "temporary_passwords"."created_at" IS '등록 일시';
COMMENT ON COLUMN "temporary_passwords"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "temporary_passwords"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "temporary_passwords"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "admin_login_logs" IS '관리자 로그인 이력';
COMMENT ON COLUMN "admin_login_logs"."login_id" IS '로그인 이력 ID';
COMMENT ON COLUMN "admin_login_logs"."admin_account_id" IS '관리자 — 없는 아이디면 비움';
COMMENT ON COLUMN "admin_login_logs"."client_address" IS '접속 IP';
COMMENT ON COLUMN "admin_login_logs"."is_succeeded" IS '성공 여부';
COMMENT ON COLUMN "admin_login_logs"."failure_reason" IS '실패 사유 — 불일치·잠금·미사용·탈퇴';
COMMENT ON COLUMN "admin_login_logs"."attempted_at" IS '시도 시각 — 1년 보존';
COMMENT ON TABLE "admin_change_histories" IS '관리자 변경 이력';
COMMENT ON COLUMN "admin_change_histories"."change_id" IS '변경 이력 ID';
COMMENT ON COLUMN "admin_change_histories"."admin_account_id" IS '대상 관리자';
COMMENT ON COLUMN "admin_change_histories"."field" IS '변경 항목 — 이름·연락처·이메일·계정상태 등';
COMMENT ON COLUMN "admin_change_histories"."before_value" IS '변경 전 값 — 비밀번호는 저장 안 함';
COMMENT ON COLUMN "admin_change_histories"."after_value" IS '변경 후 값 — 비밀번호는 저장 안 함';
COMMENT ON COLUMN "admin_change_histories"."changed_by" IS '변경자 — 본인 또는 관리자. 연쇄 미사용은 미사용 처리한 사람';
COMMENT ON COLUMN "admin_change_histories"."changed_at" IS '변경 일시 — 5년 보존';
COMMENT ON TABLE "terms_agreement_logs" IS '약관 동의 이력';
COMMENT ON COLUMN "terms_agreement_logs"."agreement_id" IS '동의 이력 ID';
COMMENT ON COLUMN "terms_agreement_logs"."admin_account_id" IS '관리자 — admin_accounts FK';
COMMENT ON COLUMN "terms_agreement_logs"."terms_version_id" IS '약관 버전 — terms_versions FK';
COMMENT ON COLUMN "terms_agreement_logs"."is_agreed" IS '동의 여부';
COMMENT ON COLUMN "terms_agreement_logs"."agreed_at" IS '동의 일시';
COMMENT ON COLUMN "terms_agreement_logs"."channel" IS '동의 경로 — 회원가입·최초 로그인·재동의·약관변경';
COMMENT ON COLUMN "terms_agreement_logs"."client_address" IS '접속 IP';
COMMENT ON TABLE "mail_send_logs" IS '메일 발송 이력';
COMMENT ON COLUMN "mail_send_logs"."mail_id" IS '발송 이력 ID';
COMMENT ON COLUMN "mail_send_logs"."mail_type_code" IS '메일 유형 코드 — 공통코드 `MAIL_TYPE`(회원가입 완료·신규 BP 가입 알림·BP 신규 등록·플랫폼 관리자 계정 생성·BP 관리자 계정 생성·비밀번호 초기화·임시 비밀번호 발급·회원 탈퇴 완료)';
COMMENT ON COLUMN "mail_send_logs"."admin_account_id" IS '수신 계정 — admin_accounts FK';
COMMENT ON COLUMN "mail_send_logs"."from_email" IS '발신 이메일 — 보낸 주소';
COMMENT ON COLUMN "mail_send_logs"."to_email" IS '수신 이메일 — 보낸 시점의 주소';
COMMENT ON COLUMN "mail_send_logs"."subject" IS '메일 제목 — 보낸 제목 그대로';
COMMENT ON COLUMN "mail_send_logs"."body" IS '메일 내용 — 보낸 본문. 초기·임시 비밀번호 값은 `********`로 가려서 저장';
COMMENT ON COLUMN "mail_send_logs"."result" IS '발송 결과 — 성공·실패';
COMMENT ON COLUMN "mail_send_logs"."failure_reason" IS '실패 사유';
COMMENT ON COLUMN "mail_send_logs"."sent_by" IS '처리자 — 관리자가 보냈을 때, 본인 요청은 비움';
COMMENT ON COLUMN "mail_send_logs"."sent_at" IS '발송 일시 — 1년 보존';
COMMENT ON TABLE "stores" IS '점포';
COMMENT ON COLUMN "stores"."store_id" IS '점포 ID';
COMMENT ON COLUMN "stores"."store_code" IS '점포코드 — ST+6자리, 고유, 자동 채번, 변경 불가';
COMMENT ON COLUMN "stores"."bp_code_id" IS 'BP — 소속 BP, bp_codes FK';
COMMENT ON COLUMN "stores"."store_type_code" IS '점포 유형 코드 — 공통코드 `STORE_TYPE`(DIRECT 직영점포·FRANCHISE 가맹점포), 변경 불가';
COMMENT ON COLUMN "stores"."name" IS '점포명 — 1~50자, 필수';
COMMENT ON COLUMN "stores"."phone" IS '점포 연락처 — 숫자 9~11자리';
COMMENT ON COLUMN "stores"."zip_code" IS '우편번호';
COMMENT ON COLUMN "stores"."address" IS '기본주소';
COMMENT ON COLUMN "stores"."address_detail" IS '상세주소';
COMMENT ON COLUMN "stores"."latitude" IS '위도 — 소수점 6자리';
COMMENT ON COLUMN "stores"."longitude" IS '경도 — 소수점 6자리';
COMMENT ON COLUMN "stores"."is_location_applied" IS '위치 적용 여부 — 기본 true(사용). true 면 3팀이 위도·경도 기준으로 출퇴근 허용 여부를 판정, false 면 위치를 보지 않음';
COMMENT ON COLUMN "stores"."closed_date" IS '폐점일 — 폐점 전환일 자동';
COMMENT ON COLUMN "stores"."store_status_code" IS '점포 상태 코드 — 공통코드 `STORE_STATUS`(미운영·운영·폐점)';
COMMENT ON COLUMN "stores"."is_deleted" IS '삭제 여부 — 미운영만 삭제 가능';
COMMENT ON COLUMN "stores"."created_at" IS '등록 일시';
COMMENT ON COLUMN "stores"."created_by" IS '등록자';
COMMENT ON COLUMN "stores"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "stores"."updated_by" IS '수정자';
COMMENT ON TABLE "store_floors" IS '점포 층별정보';
COMMENT ON COLUMN "store_floors"."store_floor_id" IS '층별정보 ID';
COMMENT ON COLUMN "store_floors"."store_id" IS '점포 — stores FK';
COMMENT ON COLUMN "store_floors"."floor_area_pyeong" IS '매장평수 — 소수 1자리, 선택';
COMMENT ON COLUMN "store_floors"."floor_area_sqm" IS '전용면적 — 소수 2자리, 선택';
COMMENT ON COLUMN "store_floors"."seat_count" IS '좌석수 — 0 이상, 선택';
COMMENT ON COLUMN "store_floors"."floor_type_code" IS '층수 구분 코드 — 공통코드 `FLOOR_TYPE`(GROUND 지상·BASEMENT 지하)';
COMMENT ON COLUMN "store_floors"."floor_number" IS '층수';
COMMENT ON COLUMN "store_floors"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "store_floors"."created_at" IS '등록 일시';
COMMENT ON COLUMN "store_floors"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "store_floors"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "store_floors"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "store_image_files" IS '점포 대표 이미지 파일';
COMMENT ON COLUMN "store_image_files"."file_id" IS '파일 ID';
COMMENT ON COLUMN "store_image_files"."store_id" IS '점포 — stores FK, 삭제되지 않은 행은 점포당 1개';
COMMENT ON COLUMN "store_image_files"."file_name" IS '원본 파일명';
COMMENT ON COLUMN "store_image_files"."file_type" IS '파일 구분 — JPG·PNG';
COMMENT ON COLUMN "store_image_files"."size_bytes" IS '파일 크기 — 5MB 이하';
COMMENT ON COLUMN "store_image_files"."storage_key" IS '저장 위치 — 파일 저장소 키';
COMMENT ON COLUMN "store_image_files"."is_deleted" IS '삭제 여부 — 교체·삭제 시 true';
COMMENT ON COLUMN "store_image_files"."created_at" IS '등록 일시';
COMMENT ON COLUMN "store_image_files"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "store_image_files"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "store_image_files"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "store_business_profiles" IS '점포 사업자정보';
COMMENT ON COLUMN "store_business_profiles"."store_id" IS '점포 — stores FK, 1:1';
COMMENT ON COLUMN "store_business_profiles"."biz_trade_name" IS '상호명 — 직접 입력, 인증과 무관';
COMMENT ON COLUMN "store_business_profiles"."biz_registration_number" IS '사업자등록번호 — 폐점·삭제되지 않은 점포끼리 고유(부분 유일), 저장 후 변경 불가';
COMMENT ON COLUMN "store_business_profiles"."biz_ceo_name" IS '대표자명 — 인증 결과만, 재인증 시 갱신';
COMMENT ON COLUMN "store_business_profiles"."biz_open_date" IS '개업일자 — 인증 결과만';
COMMENT ON COLUMN "store_business_profiles"."biz_ceo_phone" IS '대표자 연락처 — 휴대전화 10~11자리';
COMMENT ON COLUMN "store_business_profiles"."biz_zip_code" IS '사업자 우편번호';
COMMENT ON COLUMN "store_business_profiles"."biz_address" IS '사업자 기본주소';
COMMENT ON COLUMN "store_business_profiles"."biz_address_detail" IS '사업자 상세주소';
COMMENT ON COLUMN "store_business_profiles"."biz_category" IS '업태 — 50자';
COMMENT ON COLUMN "store_business_profiles"."biz_item" IS '종목 — 50자';
COMMENT ON COLUMN "store_business_profiles"."biz_verified_at" IS '최종 인증일시';
COMMENT ON COLUMN "store_business_profiles"."created_at" IS '등록 일시';
COMMENT ON COLUMN "store_business_profiles"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "store_business_profiles"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "store_business_profiles"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "store_change_histories" IS '점포 변경 이력';
COMMENT ON COLUMN "store_change_histories"."change_id" IS '변경 이력 ID';
COMMENT ON COLUMN "store_change_histories"."store_id" IS '점포';
COMMENT ON COLUMN "store_change_histories"."field" IS '변경 항목 — 점포명·점포상태·연락처·삭제 등';
COMMENT ON COLUMN "store_change_histories"."before_value" IS '변경 전 값';
COMMENT ON COLUMN "store_change_histories"."after_value" IS '변경 후 값';
COMMENT ON COLUMN "store_change_histories"."changed_by" IS '변경자 — BP 탈퇴로 자동 폐점하면 탈퇴한 BP 마스터';
COMMENT ON COLUMN "store_change_histories"."changed_at" IS '변경 일시 — 5년 보존';
COMMENT ON COLUMN "store_change_histories"."retain_end_date" IS '보존 기한 — 5년 보존 (1년 규칙 폐기)';
COMMENT ON TABLE "admin_store_mappings" IS '관리자 점포 매핑';
COMMENT ON COLUMN "admin_store_mappings"."admin_account_id" IS '관리자';
COMMENT ON COLUMN "admin_store_mappings"."store_id" IS '점포';
COMMENT ON COLUMN "admin_store_mappings"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "admin_store_mappings"."created_at" IS '등록 일시';
COMMENT ON COLUMN "admin_store_mappings"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "admin_store_mappings"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "admin_store_mappings"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "bp_change_histories" IS 'BP 변경 이력';
COMMENT ON COLUMN "bp_change_histories"."change_id" IS '변경 이력 ID';
COMMENT ON COLUMN "bp_change_histories"."bp_code_id" IS 'BP — bp_codes FK';
COMMENT ON COLUMN "bp_change_histories"."field" IS '변경 항목 — 상호명·BP상태·사업자정보 등';
COMMENT ON COLUMN "bp_change_histories"."before_value" IS '변경 전 값';
COMMENT ON COLUMN "bp_change_histories"."after_value" IS '변경 후 값';
COMMENT ON COLUMN "bp_change_histories"."changed_by" IS '변경자 — 시스템 처리는 원인 제공자';
COMMENT ON COLUMN "bp_change_histories"."changed_at" IS '변경 일시 — 5년 보존';
COMMENT ON COLUMN "bp_change_histories"."note" IS '비고 — 탈퇴 줄에만 탈퇴 사유';
COMMENT ON TABLE "role_groups" IS '권한 그룹';
COMMENT ON COLUMN "role_groups"."role_group_id" IS '권한 그룹 ID';
COMMENT ON COLUMN "role_groups"."role_code" IS '권한 코드 — 유형코드+6자리(BM000001 등), 고유, 변경 불가';
COMMENT ON COLUMN "role_groups"."bp_code_id" IS 'BP — bp_codes FK, 필수. 플랫폼 권한은 플랫폼 BP';
COMMENT ON COLUMN "role_groups"."role_type_code" IS '권한 유형 코드 — 공통코드 `ROLE_TYPE`(플랫폼 마스터·플랫폼 관리자·BP 마스터·BP 관리자·가맹 마스터·가맹 관리자), 변경 불가';
COMMENT ON COLUMN "role_groups"."name" IS '권한명 — 같은 BP·같은 관리계정ID 안 고유(BA 그룹끼리, 가맹 마스터별 FA 그룹끼리)';
COMMENT ON COLUMN "role_groups"."description" IS '설명';
COMMENT ON COLUMN "role_groups"."is_master" IS '마스터 권한 여부 — BM000001·FM000001·PM000001·PA000001';
COMMENT ON COLUMN "role_groups"."manager_admin_account_id" IS '관리계정 — FA 그룹은 만든 가맹 마스터 — 가맹 관리자의 연결 가맹 마스터는 여기서 알아낸다';
COMMENT ON COLUMN "role_groups"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "role_groups"."created_at" IS '등록 일시';
COMMENT ON COLUMN "role_groups"."created_by" IS '등록자';
COMMENT ON COLUMN "role_groups"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "role_groups"."updated_by" IS '최근 수정자';
COMMENT ON TABLE "role_group_menus" IS '권한 메뉴';
COMMENT ON COLUMN "role_group_menus"."role_group_id" IS '권한 그룹';
COMMENT ON COLUMN "role_group_menus"."menu_id" IS '메뉴';
COMMENT ON COLUMN "role_group_menus"."is_readable" IS '조회';
COMMENT ON COLUMN "role_group_menus"."is_creatable" IS '등록';
COMMENT ON COLUMN "role_group_menus"."is_updatable" IS '수정';
COMMENT ON COLUMN "role_group_menus"."is_deletable" IS '삭제';
COMMENT ON COLUMN "role_group_menus"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "role_group_menus"."created_at" IS '등록 일시';
COMMENT ON COLUMN "role_group_menus"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "role_group_menus"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "role_group_menus"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "code_groups" IS '공통코드 그룹';
COMMENT ON COLUMN "code_groups"."group_code" IS '그룹 코드 — 영문 대문자·숫자·밑줄, 영문으로 시작, 20자. 예: EMP_TYPE. 필수, 변경 불가. 삭제한 그룹의 코드도 다시 쓰지 않는다';
COMMENT ON COLUMN "code_groups"."group_name" IS '그룹명';
COMMENT ON COLUMN "code_groups"."manage_owner_code" IS '관리 주체 코드 — 공통코드 `MANAGE_OWNER` 중 플랫폼고정·플랫폼제공';
COMMENT ON COLUMN "code_groups"."is_bp_applied" IS 'BP 적용 여부 — 플랫폼제공 그룹만. 신규는 미적용, 적용으로 바꾸는 순간 사용 중인 모든 BP에 복사, 되돌릴 수 없음';
COMMENT ON COLUMN "code_groups"."description" IS '설명';
COMMENT ON COLUMN "code_groups"."status" IS '사용 상태 — 사용·사용중지';
COMMENT ON COLUMN "code_groups"."sort_order" IS '표시 순서';
COMMENT ON COLUMN "code_groups"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "code_groups"."created_at" IS '등록 일시';
COMMENT ON COLUMN "code_groups"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "code_groups"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "code_groups"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "code_items" IS '상세 코드';
COMMENT ON COLUMN "code_items"."group_code" IS '그룹 코드 — code_groups FK, 필수';
COMMENT ON COLUMN "code_items"."item_code" IS '상세코드 — 필수. 영문 대문자·숫자·밑줄, 영문으로 시작, 20자. 등록 후 변경 불가';
COMMENT ON COLUMN "code_items"."bp_code" IS 'BP 코드 — bp_codes.bp_code FK, 필수. 플랫폼 원본은 플랫폼 BP(BP000000), BP별 행(적용 때 복사된 행·BP전용 코드)은 그 BP';
COMMENT ON COLUMN "code_items"."label" IS '코드명';
COMMENT ON COLUMN "code_items"."manage_owner_code" IS '관리 주체 코드 — 공통코드 `MANAGE_OWNER`(플랫폼고정·플랫폼제공·BP전용)';
COMMENT ON COLUMN "code_items"."status" IS '사용 상태 — 사용·사용중지';
COMMENT ON COLUMN "code_items"."sort_order" IS '표시 순서';
COMMENT ON COLUMN "code_items"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "code_items"."created_at" IS '등록 일시';
COMMENT ON COLUMN "code_items"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "code_items"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "code_items"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "menus" IS '메뉴';
COMMENT ON COLUMN "menus"."menu_id" IS '메뉴 ID';
COMMENT ON COLUMN "menus"."menu_code" IS '메뉴 코드 — MN+6자리, 고유, 자동 채번, 변경 불가';
COMMENT ON COLUMN "menus"."service_code" IS '서비스 코드 — 공통코드 `SERVICE`';
COMMENT ON COLUMN "menus"."parent_menu_id" IS '상위 메뉴 — 최대 3단계';
COMMENT ON COLUMN "menus"."name" IS '노출 메뉴명 — 필수';
COMMENT ON COLUMN "menus"."url" IS '메뉴 URL';
COMMENT ON COLUMN "menus"."sort_order" IS '메뉴 순서';
COMMENT ON COLUMN "menus"."depth" IS '단계 — 1~3';
COMMENT ON COLUMN "menus"."status" IS '사용 상태 — 사용·사용중지';
COMMENT ON COLUMN "menus"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "menus"."created_at" IS '등록 일시';
COMMENT ON COLUMN "menus"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "menus"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "menus"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "bp_holidays" IS 'BP 휴일';
COMMENT ON COLUMN "bp_holidays"."bp_holiday_id" IS 'BP 휴일 ID';
COMMENT ON COLUMN "bp_holidays"."bp_code_id" IS 'BP — bp_codes FK';
COMMENT ON COLUMN "bp_holidays"."is_all_stores" IS '전체 점포 적용 여부 — true 면 전체 점포 휴일(예외 점포 제외), false 면 특정 점포 휴일(휴일-점포 매핑)';
COMMENT ON COLUMN "bp_holidays"."holiday_type_code" IS '휴일 유형 코드 — 공통코드 `HOLIDAY_TYPE`(DAY 하루·PERIOD 기간·REPEAT 반복)';
COMMENT ON COLUMN "bp_holidays"."start_date" IS '휴일 시작날짜 — 반복 기준일';
COMMENT ON COLUMN "bp_holidays"."end_date" IS '휴일 종료날짜 — 하루는 시작일과 같게 · 기간의 종료일 · 반복은 비움';
COMMENT ON COLUMN "bp_holidays"."holiday_repeat_type_code" IS '휴일 반복 유형 코드 — 공통코드 `HOLIDAY_REPEAT_TYPE`(DAILY·WEEKLY·MONTHLY·YEARLY) · 반복일 때만, 하루·기간은 비움';
COMMENT ON COLUMN "bp_holidays"."repeat_end_type" IS '반복 종료 조건 — 없음·날짜·횟수';
COMMENT ON COLUMN "bp_holidays"."repeat_end_date" IS '반복 종료일';
COMMENT ON COLUMN "bp_holidays"."repeat_count" IS '반복 횟수';
COMMENT ON COLUMN "bp_holidays"."name" IS '휴일명 — 30자';
COMMENT ON COLUMN "bp_holidays"."description" IS '설명';
COMMENT ON COLUMN "bp_holidays"."origin_bp_holiday_id" IS '원래 휴일 — bp_holidays 자기 참조, ''이후 모두'' 수정으로 분할된 경우';
COMMENT ON COLUMN "bp_holidays"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "bp_holidays"."created_at" IS '등록 일시';
COMMENT ON COLUMN "bp_holidays"."created_by" IS '등록자';
COMMENT ON COLUMN "bp_holidays"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "bp_holidays"."updated_by" IS '수정자';
COMMENT ON TABLE "holiday_store_mappings" IS '휴일 점포 매핑';
COMMENT ON COLUMN "holiday_store_mappings"."bp_holiday_id" IS '휴일 — bp_holidays FK';
COMMENT ON COLUMN "holiday_store_mappings"."store_id" IS '대상 점포 — stores FK';
COMMENT ON COLUMN "holiday_store_mappings"."effective_end_date" IS '적용 종료일 — 일부 점포를 빼거나 떼어 고칠 때 행을 지우지 않고 고른 날짜 전날을 넣는다 — 지난 날짜 보존';
COMMENT ON COLUMN "holiday_store_mappings"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "holiday_store_mappings"."created_at" IS '등록 일시';
COMMENT ON COLUMN "holiday_store_mappings"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "holiday_store_mappings"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "holiday_store_mappings"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "holiday_excluded_stores" IS '휴일 예외 점포';
COMMENT ON COLUMN "holiday_excluded_stores"."bp_holiday_id" IS '휴일 — bp_holidays FK';
COMMENT ON COLUMN "holiday_excluded_stores"."store_id" IS '예외 점포 — stores FK';
COMMENT ON COLUMN "holiday_excluded_stores"."effective_start_date" IS '적용 시작일 — 이 날짜부터 예외 — 지난 날짜 보존';
COMMENT ON COLUMN "holiday_excluded_stores"."is_deleted" IS '삭제 여부';
COMMENT ON COLUMN "holiday_excluded_stores"."created_at" IS '등록 일시';
COMMENT ON COLUMN "holiday_excluded_stores"."created_by" IS '등록자 — admin_accounts FK';
COMMENT ON COLUMN "holiday_excluded_stores"."updated_at" IS '최근 수정 일시';
COMMENT ON COLUMN "holiday_excluded_stores"."updated_by" IS '수정자 — admin_accounts FK';
COMMENT ON TABLE "bp_holiday_change_histories" IS 'BP 휴일 변경 이력';
COMMENT ON COLUMN "bp_holiday_change_histories"."change_id" IS '변경 이력 ID';
COMMENT ON COLUMN "bp_holiday_change_histories"."bp_holiday_id" IS '휴일';
COMMENT ON COLUMN "bp_holiday_change_histories"."field" IS '변경 항목';
COMMENT ON COLUMN "bp_holiday_change_histories"."before_value" IS '변경 전 값';
COMMENT ON COLUMN "bp_holiday_change_histories"."after_value" IS '변경 후 값';
COMMENT ON COLUMN "bp_holiday_change_histories"."changed_by" IS '변경자';
COMMENT ON COLUMN "bp_holiday_change_histories"."changed_at" IS '변경 일시 — 5년 보존';
COMMENT ON TABLE "public_holidays" IS '플랫폼 공식 휴일';
COMMENT ON COLUMN "public_holidays"."public_holiday_id" IS '공식 휴일 ID';
COMMENT ON COLUMN "public_holidays"."holiday_date" IS '날짜 — 한 날짜에 한 건';
COMMENT ON COLUMN "public_holidays"."year" IS '연도 — 2000~2100';
COMMENT ON COLUMN "public_holidays"."name" IS '휴일명';
COMMENT ON COLUMN "public_holidays"."note" IS '비고';
COMMENT ON COLUMN "public_holidays"."source" IS '출처 — 규칙 계산·공식 API';
COMMENT ON COLUMN "public_holidays"."source_ref" IS '공식 원본 식별자 — 공식 API일 때만';
COMMENT ON COLUMN "public_holidays"."synchronized_at" IS '최종 동기화 일시 — 공식 API일 때만';
COMMENT ON TABLE "public_holiday_synchronization_logs" IS '동기화 이력';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."synchronization_id" IS '동기화 이력 ID';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."year" IS '대상 연도 — 올해·다음 해';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."synchronized_at" IS '동기화 일시';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."created_count" IS '등록 건수';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."updated_count" IS '수정 건수';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."deleted_count" IS '삭제 건수';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."failed_count" IS '실패 건수';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."error" IS '오류 정보';
COMMENT ON COLUMN "public_holiday_synchronization_logs"."result" IS '결과 — 성공·실패';
