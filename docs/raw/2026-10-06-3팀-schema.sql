-- WHALE ERP 3팀 1차 물리 스키마 (PostgreSQL 15+)
-- docs/erd-physical/_build_physical.py 가 front docs/erd/README.md 카탈로그에서 만든다. 손으로 고치지 말 것.
-- 1팀 schema.sql(stores · bp_codes · admin_accounts)을 먼저 적용한 DB 에 얹는다. 그 테이블은 만들지 않는다.
-- whale-erp-api 로 옮길 때는 마이그레이션 SQL 로 나눠 넣는다. CHECK 제약 · 부분 고유 인덱스 · EXCLUDE 는
-- Prisma 스키마 언어로 표현되지 않으므로 마이그레이션 SQL 에만 남는다.

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- work_schedules 겹침 금지

-- ── enum ──
CREATE TYPE "identity_verification_purpose" AS ENUM ('SIGNUP', 'PHONE_CHANGE');  -- 가입 · 휴대전화번호 변경
CREATE TYPE "identity_verification_result" AS ENUM ('SUCCEEDED', 'FAILED');  -- 성공 · 실패
CREATE TYPE "account_status" AS ENUM ('JOINED', 'LINK_HOLD');  -- 가입 완료 · 연결 보류
CREATE TYPE "account_change_field" AS ENUM ('PHONE', 'EMAIL', 'ADDRESS', 'PASSWORD');  -- 휴대전화번호 · 이메일 · 주소 · 비밀번호
CREATE TYPE "account_change_channel" AS ENUM ('SELF', 'PIN_RESET', 'ADMIN_RESET');  -- 본인 · 핀 재설정 · 관리자 초기화
CREATE TYPE "account_login_failure_reason" AS ENUM ('PASSWORD_MISMATCH', 'ACCOUNT_NOT_FOUND', 'LOCKED');  -- 불일치 · 없는 계정 · 잠금
CREATE TYPE "location_access_action" AS ENUM ('COLLECT', 'USE', 'PROVIDE');  -- 수집 · 이용 · 제공
CREATE TYPE "employment_type" AS ENUM ('FULL_TIME', 'PART_TIME');  -- 정직원 · 파트타이머
CREATE TYPE "employment_status" AS ENUM ('EMPLOYED', 'RETIRED');  -- 재직 · 퇴직
CREATE TYPE "staff_member_join_status" AS ENUM ('DRAFT', 'INVITED', 'JOINED');  -- 초안 · 초대 발송 · 가입 완료
CREATE TYPE "invitation_type" AS ENUM ('SIGNUP', 'REINVITE', 'AFFILIATION_CONFIRM', 'RETURN_CONFIRM');  -- 가입 초대 · 재초대 · 소속 추가 확인 · 복귀 확인
CREATE TYPE "invitation_channel" AS ENUM ('SMS', 'ALIMTALK');  -- SMS · 알림톡
CREATE TYPE "invitation_status" AS ENUM ('SENT', 'ACCEPTED', 'EXPIRED', 'REJECTED', 'REJECTED_UNDER_AGE');  -- 발송 · 수락 · 만료 · 거절 · 가입 불가(만 19세 미만)
CREATE TYPE "link_hold_mismatch_reason" AS ENUM ('PHONE_MISMATCH', 'NAME_MISMATCH');  -- 번호 불일치 · 이름 불일치
CREATE TYPE "link_hold_resolution" AS ENUM ('APPROVED', 'REINVITED');  -- 승인 · 번호 수정 후 재초대
CREATE TYPE "contract_method" AS ENUM ('ELECTRONIC', 'PAPER');  -- 전자계약 · 종이 계약
CREATE TYPE "weekday" AS ENUM ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN');  -- 월 · 화 · 수 · 목 · 금 · 토 · 일
CREATE TYPE "contract_status" AS ENUM ('PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED', 'EXPIRED', 'ENDED');  -- 발송 대기 · 서명 대기 · 체결 완료 · 거부 · 만료 · 종료
CREATE TYPE "contract_draft_action" AS ENUM ('SIGNUP_INVITE', 'AFFILIATION_CONFIRM', 'RETURN_CONFIRM', 'IMMEDIATE_SEND');  -- 가입 초대 · 소속 추가 확인 · 복귀 확인 · 즉시 발송
CREATE TYPE "contract_document_kind" AS ENUM ('SENT_ORIGINAL', 'SIGNED_COPY', 'PAPER_EMPLOYMENT_CONTRACT', 'WAGE_CONTRACT');  -- 발송 원본 · 날인 완료본 · 종이 계약 근로계약서 · 임금계약서
CREATE TYPE "status_change_actor" AS ENUM ('ADMIN', 'STAFF', 'SYSTEM');  -- 관리자 · 직원 · 시스템
CREATE TYPE "work_type" AS ENUM ('DAY', 'OPEN', 'MIDDLE', 'CLOSE');  -- 주간 · 오픈 · 미들 · 마감
CREATE TYPE "work_schedule_confirm_status" AS ENUM ('UNCONFIRMED', 'CONFIRMED');  -- 확정 전 · 확정
CREATE TYPE "work_schedule_change_type" AS ENUM ('CREATED', 'UPDATED', 'DELETED');  -- 등록 · 수정 · 삭제
CREATE TYPE "attendance_kind" AS ENUM ('CHECK_IN', 'CHECK_OUT');  -- 출근 · 퇴근
CREATE TYPE "attendance_review_reason" AS ENUM ('ACCURACY_EXCEEDED', 'OUT_OF_RADIUS_CHECKOUT', 'MOCK_LOCATION');  -- 위치 오차 초과 · 반경 밖 퇴근 · 위치 조작 감지
CREATE TYPE "attendance_entry_method" AS ENUM ('SELF', 'PROXY');  -- 직원 등록 · 대신 등록
CREATE TYPE "todo_assignee_type" AS ENUM ('INDIVIDUAL', 'ALL');  -- 개인 · 근무지 전체
CREATE TYPE "todo_execution_mode" AS ENUM ('EACH', 'ANY_ONE');  -- 각자 수행 · 한 명 수행
CREATE TYPE "todo_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE');  -- 대기 · 진행 중 · 완료
CREATE TYPE "payslip_status" AS ENUM ('DRAFTING', 'REVIEWING', 'CONFIRMED', 'SENT');  -- 작성 중 · 검토 중 · 확정 · 발송 완료
CREATE TYPE "payslip_item_category" AS ENUM ('EARNING', 'BASIC', 'ADDITIONAL', 'WITHHOLDING');  -- 지급 · 기본 공제 · 추가 공제 · 원천징수
CREATE TYPE "payslip_review_reason" AS ENUM ('MISSING_ATTENDANCE', 'AFTER_CONTRACT_END', 'CONTRACT_CHANGED', 'DEDUCTION_MISSING');  -- 출퇴근 누락 · 계약 만료 후 기록 · 기간 중 계약 변경 · 공제 미입력
CREATE TYPE "payslip_dispatch_channel" AS ENUM ('EMAIL', 'PUSH');  -- 이메일 · 앱 푸시
CREATE TYPE "dispatch_result" AS ENUM ('SUCCEEDED', 'FAILED');  -- 성공 · 실패
CREATE TYPE "payslip_log_type" AS ENUM ('DRAFT', 'EDIT', 'CONFIRM', 'CANCEL_CONFIRMATION', 'SEND');  -- 초안 생성 · 수정 · 확정 · 확정 취소 · 발송
CREATE TYPE "notification_target" AS ENUM ('ADMIN', 'STAFF');  -- 운영 알림 · 직원 알림
CREATE TYPE "notification_channel" AS ENUM ('PUSH', 'ALIMTALK', 'EMAIL');  -- 앱 푸시 · 알림톡 · 이메일
CREATE TYPE "retirement_action" AS ENUM ('RETIRE', 'CANCEL');  -- 처리 · 취소
CREATE TYPE "preference_category" AS ENUM ('CONTRACT', 'SCHEDULE', 'TODO', 'PAYSLIP');  -- 근로계약서 · 근무스케줄 · TO-DO · 급여명세서
CREATE TYPE "notification_template_channel" AS ENUM ('NOTIFICATION', 'PUSH', 'EMAIL', 'ALIMTALK');  -- 운영 알림 · 앱 푸시 · 메일 · 알림톡
CREATE TYPE "post_content_type" AS ENUM ('NOTICE', 'FAQ');  -- 공지사항 · FAQ
CREATE TYPE "post_status" AS ENUM ('DRAFT', 'PUBLISHED', 'PRIVATE');  -- 임시저장 · 게시 · 비공개
CREATE TYPE "notice_type" AS ENUM ('MAINTENANCE', 'FEATURE', 'TERMS', 'GENERAL');  -- 점검 · 기능 · 약관 · 안내
CREATE TYPE "post_audience_type" AS ENUM ('GUEST', 'MEMBER', 'BP', 'STORE', 'ADDON');  -- 비회원 · 회원 · BP · 점포 · 부가서비스
CREATE TYPE "inquiry_status" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'ANSWERED');  -- 접수 · 처리중 · 답변완료
CREATE TYPE "lead_interest" AS ENUM ('STORE_OPERATION', 'FINANCE', 'FRANCHISE', 'OTHER');  -- 매장운영 · 재무관리 · 프랜차이즈 · 기타

-- 본인인증 이력
CREATE TABLE "identity_verifications" (
    "identity_verification_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER,
    "purpose" "identity_verification_purpose" NOT NULL,
    "phone" TEXT NOT NULL,
    "result" "identity_verification_result" NOT NULL,
    "verified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("identity_verification_id")
);

-- 접속 상태
CREATE TABLE "auth_sessions" (
    "auth_session_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "device_identifier" TEXT,
    "refresh_token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("auth_session_id")
);

-- 계정
CREATE TABLE "accounts" (
    "account_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "real_name" TEXT NOT NULL,
    "birth_date" DATE NOT NULL,
    "phone" TEXT NOT NULL,
    "connecting_information" TEXT,
    "zip_code" TEXT,
    "address" TEXT,
    "address_detail" TEXT,
    "status" "account_status" NOT NULL,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "lock_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("account_id")
);

-- 계정 변경 이력
CREATE TABLE "account_change_histories" (
    "account_change_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "field" "account_change_field" NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "channel" "account_change_channel" NOT NULL,
    "requested_by" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_change_histories_pkey" PRIMARY KEY ("account_change_history_id")
);

-- 로그인 이력
CREATE TABLE "login_histories" (
    "login_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER,
    "email" TEXT NOT NULL,
    "is_succeeded" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" "account_login_failure_reason",
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_histories_pkey" PRIMARY KEY ("login_history_id")
);

-- 비밀번호 재설정 핀
CREATE TABLE "password_reset_pins" (
    "password_reset_pin_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "password_reset_pins_pkey" PRIMARY KEY ("password_reset_pin_id")
);

-- 위치정보 확인자료
CREATE TABLE "location_access_logs" (
    "location_access_log_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "action" "location_access_action" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "recipient" TEXT,
    "purpose" TEXT,
    "attendance_record_id" INTEGER,

    CONSTRAINT "location_access_logs_pkey" PRIMARY KEY ("location_access_log_id")
);

-- 직원 레코드
CREATE TABLE "staff_members" (
    "staff_member_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "store_id" INTEGER NOT NULL,
    "account_id" INTEGER,
    "candidate_account_id" INTEGER,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "employment_type" "employment_type" NOT NULL,
    "job_title" TEXT NOT NULL,
    "hired_date" DATE,
    "employment_status" "employment_status" NOT NULL DEFAULT 'EMPLOYED',
    "join_status" "staff_member_join_status" NOT NULL DEFAULT 'DRAFT',
    "retired_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("staff_member_id")
);

-- 신고 정보
CREATE TABLE "staff_tax_profiles" (
    "staff_member_id" INTEGER NOT NULL,
    "rrn_encrypted" BYTEA NOT NULL,
    "bank_code" TEXT NOT NULL,
    "payroll_account_number_encrypted" BYTEA NOT NULL,
    "purpose" TEXT NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_tax_profiles_pkey" PRIMARY KEY ("staff_member_id")
);

-- 초대
CREATE TABLE "invitations" (
    "invitation_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "invitation_type" "invitation_type" NOT NULL,
    "invitation_token" TEXT,
    "channel" "invitation_channel" NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "invitation_status" NOT NULL,
    "responded_at" TIMESTAMPTZ(6),
    "reject_reason" TEXT,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("invitation_id")
);

-- 가입 연결 보류
CREATE TABLE "link_holds" (
    "link_hold_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "invitation_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "mismatch_reason" "link_hold_mismatch_reason" NOT NULL,
    "resolution" "link_hold_resolution",
    "resolved_by" INTEGER,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_holds_pkey" PRIMARY KEY ("link_hold_id")
);

-- 퇴직 처리 이력
CREATE TABLE "staff_member_retirement_logs" (
    "staff_member_retirement_log_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "action" "retirement_action" NOT NULL,
    "retired_date" DATE NOT NULL,
    "contract_id" INTEGER,
    "previous_contract_end_date" DATE,
    "processed_by" INTEGER NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_member_retirement_logs_pkey" PRIMARY KEY ("staff_member_retirement_log_id")
);

-- 근로계약
CREATE TABLE "contracts" (
    "contract_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "previous_contract_id" INTEGER,
    "employment_type" "employment_type" NOT NULL,
    "contract_method" "contract_method" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "work_terms" JSONB NOT NULL,
    "weekly_holiday" "weekday",
    "is_health_pension_insured" BOOLEAN NOT NULL DEFAULT false,
    "is_employment_injury_insured" BOOLEAN NOT NULL DEFAULT false,
    "wage_terms" JSONB NOT NULL,
    "status" "contract_status" NOT NULL DEFAULT 'PENDING_SEND',
    "draft_action" "contract_draft_action",
    "sent_at" TIMESTAMPTZ(6),
    "sign_deadline_at" TIMESTAMPTZ(6),
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "reject_reason" TEXT,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("contract_id")
);

-- 계약 당사자 정보
CREATE TABLE "contract_parties" (
    "contract_id" INTEGER NOT NULL,
    "entered_name" TEXT,
    "entered_phone" TEXT,
    "entered_birth_date" DATE,
    "verified_name" TEXT,
    "verified_birth_date" TEXT,
    "verified_phone" TEXT,
    "zip_code" TEXT,
    "address" TEXT,
    "address_detail" TEXT,
    "filled_at" TIMESTAMPTZ(6),

    CONSTRAINT "contract_parties_pkey" PRIMARY KEY ("contract_id")
);

-- 계약서 파일
CREATE TABLE "contract_documents" (
    "contract_document_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "contract_id" INTEGER NOT NULL,
    "kind" "contract_document_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_documents_pkey" PRIMARY KEY ("contract_document_id")
);

-- 계약 상태 이력
CREATE TABLE "contract_status_histories" (
    "contract_status_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "contract_id" INTEGER NOT NULL,
    "from_status" "contract_status",
    "to_status" "contract_status" NOT NULL,
    "actor" "status_change_actor" NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_status_histories_pkey" PRIMARY KEY ("contract_status_history_id")
);

-- 근무스케줄
CREATE TABLE "work_schedules" (
    "work_schedule_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "work_type" "work_type",
    "confirm_status" "work_schedule_confirm_status" NOT NULL DEFAULT 'UNCONFIRMED',
    "source_contract_id" INTEGER,
    "created_by" INTEGER NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("work_schedule_id")
);

-- 근무스케줄 변경 이력
CREATE TABLE "work_schedule_histories" (
    "work_schedule_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "work_schedule_id" INTEGER NOT NULL,
    "change_type" "work_schedule_change_type" NOT NULL,
    "before_value" JSONB,
    "after_value" JSONB,
    "changed_by" INTEGER NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_schedule_histories_pkey" PRIMARY KEY ("work_schedule_history_id")
);

-- 위치정보 동의
CREATE TABLE "location_consents" (
    "location_consent_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "account_id" INTEGER NOT NULL,
    "consent_version" TEXT NOT NULL,
    "agreed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paused_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),

    CONSTRAINT "location_consents_pkey" PRIMARY KEY ("location_consent_id")
);

-- 출퇴근 기록
CREATE TABLE "attendance_records" (
    "attendance_record_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "kind" "attendance_kind" NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_reason" "attendance_review_reason",
    "reviewed_by" INTEGER,
    "reviewed_at" TIMESTAMPTZ(6),
    "entry_method" "attendance_entry_method" NOT NULL DEFAULT 'SELF',
    "proxy_by" INTEGER,
    "proxy_reason" TEXT,
    "has_unsigned_warning" BOOLEAN NOT NULL DEFAULT false,
    "check_in_attendance_record_id" INTEGER,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("attendance_record_id")
);

-- 출퇴근 보정 이력
CREATE TABLE "attendance_corrections" (
    "attendance_correction_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "attendance_record_id" INTEGER NOT NULL,
    "before_value" JSONB NOT NULL,
    "after_value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "corrected_by" INTEGER NOT NULL,
    "corrected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("attendance_correction_id")
);

-- TO-DO
CREATE TABLE "todos" (
    "todo_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "store_id" INTEGER NOT NULL,
    "assignment_group_id" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "assignee_type" "todo_assignee_type" NOT NULL,
    "execution_mode" "todo_execution_mode" NOT NULL,
    "due_date" DATE NOT NULL,
    "due_time" TIME,
    "is_urgent" BOOLEAN NOT NULL DEFAULT false,
    "status" "todo_status" NOT NULL DEFAULT 'PENDING',
    "performer_staff_member_id" INTEGER,
    "completed_at" TIMESTAMPTZ(6),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "todos_pkey" PRIMARY KEY ("todo_id")
);

-- TO-DO 배정 대상
CREATE TABLE "todo_assignees" (
    "todo_id" INTEGER NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "todo_assignees_pkey" PRIMARY KEY ("todo_id", "staff_member_id")
);

-- TO-DO 상태 이력
CREATE TABLE "todo_status_histories" (
    "todo_status_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "todo_id" INTEGER NOT NULL,
    "from_status" "todo_status",
    "to_status" "todo_status" NOT NULL,
    "is_urgent_changed" BOOLEAN NOT NULL DEFAULT false,
    "changed_by" INTEGER,
    "staff_member_id" INTEGER,
    "unassigned_staff_member_id" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "todo_status_histories_pkey" PRIMARY KEY ("todo_status_history_id")
);

-- 급여명세서
CREATE TABLE "payslips" (
    "payslip_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "staff_member_id" INTEGER NOT NULL,
    "store_id" INTEGER NOT NULL,
    "contract_id" INTEGER NOT NULL,
    "period_start_date" DATE NOT NULL,
    "period_end_date" DATE NOT NULL,
    "employment_type" "employment_type" NOT NULL,
    "attendance_start_date" DATE NOT NULL,
    "attendance_end_date" DATE NOT NULL,
    "status" "payslip_status" NOT NULL DEFAULT 'DRAFTING',
    "is_premium_applied" BOOLEAN NOT NULL DEFAULT true,
    "is_withholding_applied" BOOLEAN NOT NULL DEFAULT false,
    "gross_pay_amount" INTEGER NOT NULL DEFAULT 0,
    "total_deduction_amount" INTEGER NOT NULL DEFAULT 0,
    "net_pay_amount" INTEGER NOT NULL DEFAULT 0,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("payslip_id")
);

-- 명세서 금액 항목
CREATE TABLE "payslip_items" (
    "payslip_item_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "payslip_id" INTEGER NOT NULL,
    "item_category" "payslip_item_category" NOT NULL,
    "payslip_item_master_id" INTEGER NOT NULL,
    "item_name" TEXT NOT NULL,
    "is_tax_free" BOOLEAN NOT NULL DEFAULT false,
    "calculated_amount" INTEGER,
    "adjusted_amount" INTEGER,
    "is_entered" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "payslip_items_pkey" PRIMARY KEY ("payslip_item_id")
);

-- 급여 항목
CREATE TABLE "payslip_item_masters" (
    "payslip_item_master_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "item_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "payslip_item_category" NOT NULL,
    "is_tax_free" BOOLEAN NOT NULL DEFAULT false,
    "is_system_calculated" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "payslip_item_masters_pkey" PRIMARY KEY ("payslip_item_master_id")
);

-- 검토 대기 사유
CREATE TABLE "payslip_review_reasons" (
    "payslip_review_reason_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "payslip_id" INTEGER NOT NULL,
    "review_reason" "payslip_review_reason" NOT NULL,
    "detail" TEXT,
    "acknowledged_at" TIMESTAMPTZ(6),

    CONSTRAINT "payslip_review_reasons_pkey" PRIMARY KEY ("payslip_review_reason_id")
);

-- 명세서 발송 이력
CREATE TABLE "payslip_dispatches" (
    "payslip_dispatch_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "payslip_id" INTEGER NOT NULL,
    "channel" "payslip_dispatch_channel" NOT NULL,
    "status" "dispatch_result" NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_by" INTEGER,

    CONSTRAINT "payslip_dispatches_pkey" PRIMARY KEY ("payslip_dispatch_id")
);

-- 명세서 처리 이력
CREATE TABLE "payslip_logs" (
    "payslip_log_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "payslip_id" INTEGER NOT NULL,
    "log_type" "payslip_log_type" NOT NULL,
    "from_status" "payslip_status",
    "to_status" "payslip_status",
    "summary" TEXT NOT NULL,
    "changed_by" INTEGER,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslip_logs_pkey" PRIMARY KEY ("payslip_log_id")
);

-- 알림
CREATE TABLE "notifications" (
    "notification_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "notification_target" "notification_target" NOT NULL,
    "template_code" TEXT NOT NULL,
    "related_type" TEXT,
    "related_id" INTEGER,
    "body" TEXT NOT NULL,
    "dedupe_key" TEXT,
    "is_urgent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("notification_id")
);

-- 알림 수신
CREATE TABLE "notification_recipients" (
    "notification_recipient_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "notification_id" INTEGER NOT NULL,
    "account_id" INTEGER,
    "admin_account_id" INTEGER,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(6),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("notification_recipient_id")
);

-- 알림 발송 이력
CREATE TABLE "notification_deliveries" (
    "notification_delivery_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "notification_recipient_id" INTEGER NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "result" "dispatch_result",
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "delivery_batch_id" INTEGER,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("notification_delivery_id")
);

-- 알림 수신 설정
CREATE TABLE "notification_preferences" (
    "account_id" INTEGER NOT NULL,
    "preference_category" "preference_category" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("account_id", "preference_category")
);

-- 알림 템플릿
CREATE TABLE "notification_templates" (
    "notification_template_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "template_code" TEXT NOT NULL,
    "channel" "notification_template_channel" NOT NULL,
    "template_name" TEXT NOT NULL,
    "preference_category" "preference_category",
    "title" TEXT,
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "kakao_template_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("notification_template_id")
);

-- 알림 템플릿 변경 이력
CREATE TABLE "notification_template_histories" (
    "notification_template_history_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "notification_template_id" INTEGER NOT NULL,
    "template_code" TEXT NOT NULL,
    "channel" "notification_template_channel" NOT NULL,
    "template_name" TEXT NOT NULL,
    "preference_category" "preference_category",
    "kakao_template_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "changed_by" INTEGER NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_template_histories_pkey" PRIMARY KEY ("notification_template_history_id")
);

-- 공지사항·FAQ
CREATE TABLE "posts" (
    "post_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "content_type" "post_content_type" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "post_status" NOT NULL DEFAULT 'DRAFT',
    "notice_type" "notice_type",
    "publish_start_date" DATE,
    "publish_end_date" DATE,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "faq_category_code" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("post_id")
);

-- 노출 대상
CREATE TABLE "post_audiences" (
    "post_audience_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "post_id" INTEGER NOT NULL,
    "audience_type" "post_audience_type" NOT NULL,
    "service_code" TEXT,

    CONSTRAINT "post_audiences_pkey" PRIMARY KEY ("post_audience_id")
);

-- 첨부파일
CREATE TABLE "post_attachments" (
    "post_attachment_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "post_id" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_attachments_pkey" PRIMARY KEY ("post_attachment_id")
);

-- 문의사항
CREATE TABLE "inquiries" (
    "inquiry_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "created_by" INTEGER NOT NULL,
    "bp_code_id" INTEGER NOT NULL,
    "store_id" INTEGER,
    "inquiry_category_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "inquiry_status" NOT NULL DEFAULT 'RECEIVED',
    "internal_memo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("inquiry_id")
);

-- 문의 답변
CREATE TABLE "inquiry_replies" (
    "inquiry_reply_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "inquiry_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "replied_by" INTEGER NOT NULL,
    "replied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inquiry_replies_pkey" PRIMARY KEY ("inquiry_reply_id")
);

-- 도입문의
CREATE TABLE "leads" (
    "lead_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "contact_name" TEXT NOT NULL,
    "industry_code" TEXT NOT NULL,
    "industry_detail" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "interests" "lead_interest"[] NOT NULL,
    "plan_period_code" TEXT,
    "body" TEXT NOT NULL,
    "privacy_agreed_at" TIMESTAMPTZ(6) NOT NULL,
    "marketing_agreed_at" TIMESTAMPTZ(6),
    "status" "inquiry_status" NOT NULL DEFAULT 'RECEIVED',
    "reply" TEXT,
    "internal_memo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consulted_date" DATE,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("lead_id")
);

-- ── CHECK 제약 ──
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_lower" CHECK ("email" = lower("email"));
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_phone_format" CHECK ("phone" ~ '^[0-9]{10,11}$');
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_failed_login_count_nonnegative" CHECK ("failed_login_count" >= 0);
ALTER TABLE "password_reset_pins" ADD CONSTRAINT "password_reset_pins_attempt_count_range" CHECK ("attempt_count" BETWEEN 0 AND 5);
ALTER TABLE "location_access_logs" ADD CONSTRAINT "location_access_logs_provide_fields" CHECK ("action" <> 'PROVIDE' OR ("recipient" IS NOT NULL AND "purpose" IS NOT NULL));
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_phone_format" CHECK ("phone" ~ '^[0-9]{10,11}$');
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_retired_date_required" CHECK ("employment_status" <> 'RETIRED' OR "retired_date" IS NOT NULL);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_token_required" CHECK ("invitation_type" NOT IN ('SIGNUP', 'REINVITE') OR "invitation_token" IS NOT NULL);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_end_date_after_start" CHECK ("end_date" IS NULL OR "end_date" >= "start_date");
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_resend_count_nonnegative" CHECK ("resend_count" >= 0);
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_end_after_start" CHECK ("end_at" > "start_at");
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_break_minutes_nonnegative" CHECK ("break_minutes" >= 0);
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_proxy_fields" CHECK ("entry_method" <> 'PROXY' OR ("proxy_by" IS NOT NULL AND "proxy_reason" IS NOT NULL));
ALTER TABLE "todo_status_histories" ADD CONSTRAINT "todo_status_histories_single_actor" CHECK (num_nonnulls("changed_by", "staff_member_id") <= 1);
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_period_end_after_start" CHECK ("period_end_date" >= "period_start_date");
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_attendance_end_after_start" CHECK ("attendance_end_date" >= "attendance_start_date");
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_net_pay_amount_balance" CHECK ("net_pay_amount" = "gross_pay_amount" - "total_deduction_amount");
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_single_recipient" CHECK (num_nonnulls("account_id", "admin_account_id") = 1);
ALTER TABLE "post_audiences" ADD CONSTRAINT "post_audiences_service_code_required" CHECK (("audience_type" = 'ADDON') = ("service_code" IS NOT NULL));
ALTER TABLE "payslip_item_masters" ADD CONSTRAINT "payslip_item_masters_item_code_format" CHECK ("item_code" ~ '^[A-Z][A-Z0-9_]*$');
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_size_bytes_range" CHECK ("size_bytes" BETWEEN 1 AND 10485760);
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_preference_category_push_only" CHECK (("channel" = 'PUSH') = ("preference_category" IS NOT NULL));
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_mandatory_enabled" CHECK ("preference_category" NOT IN ('CONTRACT', 'PAYSLIP') OR "is_enabled");
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_alimtalk_fields" CHECK (("channel" = 'ALIMTALK') = ("kakao_template_code" IS NOT NULL));
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_template_code_format" CHECK ("template_code" ~ '^[A-Z][A-Z0-9_]*$');
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_contract_only_on_retire" CHECK ("action" = 'RETIRE' OR ("contract_id" IS NULL AND "previous_contract_end_date" IS NULL));
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_end_date_needs_contract" CHECK ("previous_contract_end_date" IS NULL OR "contract_id" IS NOT NULL);
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_variables_array" CHECK (jsonb_typeof("variables") = 'array');
ALTER TABLE "notification_template_histories" ADD CONSTRAINT "notification_template_histories_variables_array" CHECK (jsonb_typeof("variables") = 'array');
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_title_by_channel" CHECK (("channel" = 'ALIMTALK') = ("title" IS NULL));
ALTER TABLE "posts" ADD CONSTRAINT "posts_publish_end_after_start" CHECK ("publish_end_date" IS NULL OR "publish_end_date" >= "publish_start_date");

-- ── 겹침 금지 ──
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_no_overlap" EXCLUDE USING gist ("staff_member_id" WITH =, tstzrange("start_at", "end_at") WITH &&) WHERE (NOT "is_deleted");  -- 같은 직원의 근무스케줄은 겹치지 않는다

-- ── 고유 제약 ──
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts" ("email");  -- 로그인 아이디 — 탈퇴 처리 방식이 정해지면 조건을 붙인다
CREATE UNIQUE INDEX "accounts_connecting_information_key" ON "accounts" ("connecting_information");  -- 동일인 한 계정
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key" ON "auth_sessions" ("refresh_token_hash");  -- 갱신 토큰 한 행
CREATE UNIQUE INDEX "invitations_invitation_token_key" ON "invitations" ("invitation_token") WHERE "invitation_token" IS NOT NULL;  -- 토큰은 가입 초대·재초대만
CREATE UNIQUE INDEX "location_consents_account_id_key" ON "location_consents" ("account_id") WHERE "withdrawn_at" IS NULL;  -- 철회하지 않은 동의는 계정당 하나
CREATE UNIQUE INDEX "payslips_staff_member_id_period_start_date_period_end_date_key" ON "payslips" ("staff_member_id", "period_start_date", "period_end_date");  -- 같은 기간 중복 생성 차단
CREATE UNIQUE INDEX "payslip_items_payslip_id_payslip_item_master_id_key" ON "payslip_items" ("payslip_id", "payslip_item_master_id");  -- 명세서 한 장에 같은 항목 한 줄
CREATE UNIQUE INDEX "payslip_item_masters_item_code_key" ON "payslip_item_masters" ("item_code");  -- 항목 코드 (2026-10-07 재영)
CREATE UNIQUE INDEX "payslip_review_reasons_payslip_id_review_reason_key" ON "payslip_review_reasons" ("payslip_id", "review_reason");  -- 명세서 한 장에 같은 사유 한 건
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;  -- 같은 사건·수신자 1회
CREATE UNIQUE INDEX "notification_templates_template_code_key" ON "notification_templates" ("template_code");  -- 화면·로그·문의 대응에서 템플릿 하나를 가리키는 코드 (2026-10-07 재영)
CREATE UNIQUE INDEX "post_audiences_post_id_audience_type_service_code_key" ON "post_audiences" ("post_id", "audience_type", "service_code") NULLS NOT DISTINCT;  -- 게시물마다 대상 한 번. 부가서비스가 아닌 대상(service_code NULL)끼리도 겹치지 않게 NULLS NOT DISTINCT

-- ── 외래키 (모두 ON DELETE RESTRICT — 삭제는 is_deleted 로 하는 논리 삭제다) ──
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "account_change_histories" ADD CONSTRAINT "account_change_histories_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "account_change_histories" ADD CONSTRAINT "account_change_histories_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "login_histories" ADD CONSTRAINT "login_histories_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "password_reset_pins" ADD CONSTRAINT "password_reset_pins_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "location_access_logs" ADD CONSTRAINT "location_access_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "location_access_logs" ADD CONSTRAINT "location_access_logs_attendance_record_id_fkey" FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records" ("attendance_record_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_candidate_account_id_fkey" FOREIGN KEY ("candidate_account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_tax_profiles" ADD CONSTRAINT "staff_tax_profiles_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "link_holds" ADD CONSTRAINT "link_holds_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations" ("invitation_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "link_holds" ADD CONSTRAINT "link_holds_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "link_holds" ADD CONSTRAINT "link_holds_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "staff_member_retirement_logs" ADD CONSTRAINT "staff_member_retirement_logs_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_previous_contract_id_fkey" FOREIGN KEY ("previous_contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "contract_parties" ADD CONSTRAINT "contract_parties_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "contract_status_histories" ADD CONSTRAINT "contract_status_histories_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_source_contract_id_fkey" FOREIGN KEY ("source_contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "work_schedule_histories" ADD CONSTRAINT "work_schedule_histories_work_schedule_id_fkey" FOREIGN KEY ("work_schedule_id") REFERENCES "work_schedules" ("work_schedule_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "work_schedule_histories" ADD CONSTRAINT "work_schedule_histories_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "location_consents" ADD CONSTRAINT "location_consents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_proxy_by_fkey" FOREIGN KEY ("proxy_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_check_in_attendance_record_id_fkey" FOREIGN KEY ("check_in_attendance_record_id") REFERENCES "attendance_records" ("attendance_record_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_attendance_record_id_fkey" FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records" ("attendance_record_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_corrected_by_fkey" FOREIGN KEY ("corrected_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todos" ADD CONSTRAINT "todos_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todos" ADD CONSTRAINT "todos_performer_staff_member_id_fkey" FOREIGN KEY ("performer_staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todos" ADD CONSTRAINT "todos_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todo_assignees" ADD CONSTRAINT "todo_assignees_todo_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos" ("todo_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todo_assignees" ADD CONSTRAINT "todo_assignees_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todo_status_histories" ADD CONSTRAINT "todo_status_histories_todo_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos" ("todo_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todo_status_histories" ADD CONSTRAINT "todo_status_histories_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todo_status_histories" ADD CONSTRAINT "todo_status_histories_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "todo_status_histories" ADD CONSTRAINT "todo_status_histories_unassigned_staff_member_id_fkey" FOREIGN KEY ("unassigned_staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts" ("contract_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslip_items" ADD CONSTRAINT "payslip_items_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips" ("payslip_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslip_items" ADD CONSTRAINT "payslip_items_payslip_item_master_id_fkey" FOREIGN KEY ("payslip_item_master_id") REFERENCES "payslip_item_masters" ("payslip_item_master_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslip_review_reasons" ADD CONSTRAINT "payslip_review_reasons_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips" ("payslip_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslip_dispatches" ADD CONSTRAINT "payslip_dispatches_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips" ("payslip_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslip_dispatches" ADD CONSTRAINT "payslip_dispatches_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslip_logs" ADD CONSTRAINT "payslip_logs_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips" ("payslip_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "payslip_logs" ADD CONSTRAINT "payslip_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications" ("notification_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_recipient_id_fkey" FOREIGN KEY ("notification_recipient_id") REFERENCES "notification_recipients" ("notification_recipient_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_template_histories" ADD CONSTRAINT "notification_template_histories_notification_template_id_fkey" FOREIGN KEY ("notification_template_id") REFERENCES "notification_templates" ("notification_template_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_template_histories" ADD CONSTRAINT "notification_template_histories_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "posts" ADD CONSTRAINT "posts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "post_audiences" ADD CONSTRAINT "post_audiences_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts" ("post_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts" ("post_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_bp_code_id_fkey" FOREIGN KEY ("bp_code_id") REFERENCES "bp_codes" ("bp_code_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("store_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "inquiry_replies" ADD CONSTRAINT "inquiry_replies_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries" ("inquiry_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "inquiry_replies" ADD CONSTRAINT "inquiry_replies_replied_by_fkey" FOREIGN KEY ("replied_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ── 조회 인덱스 ──
CREATE INDEX "identity_verifications_account_id_idx" ON "identity_verifications" ("account_id");
CREATE INDEX "auth_sessions_account_id_idx" ON "auth_sessions" ("account_id");
CREATE INDEX "account_change_histories_account_id_changed_at_idx" ON "account_change_histories" ("account_id", "changed_at");
CREATE INDEX "login_histories_account_id_attempted_at_idx" ON "login_histories" ("account_id", "attempted_at");
CREATE INDEX "password_reset_pins_account_id_idx" ON "password_reset_pins" ("account_id");
CREATE INDEX "location_access_logs_account_id_occurred_at_idx" ON "location_access_logs" ("account_id", "occurred_at");
CREATE INDEX "staff_members_store_id_idx" ON "staff_members" ("store_id");
CREATE INDEX "staff_members_account_id_idx" ON "staff_members" ("account_id");
CREATE INDEX "invitations_staff_member_id_idx" ON "invitations" ("staff_member_id");
CREATE INDEX "link_holds_invitation_id_idx" ON "link_holds" ("invitation_id");
CREATE INDEX "contracts_staff_member_id_idx" ON "contracts" ("staff_member_id");
CREATE INDEX "contracts_store_id_status_idx" ON "contracts" ("store_id", "status");
CREATE INDEX "contract_documents_contract_id_idx" ON "contract_documents" ("contract_id");
CREATE INDEX "contract_status_histories_contract_id_changed_at_idx" ON "contract_status_histories" ("contract_id", "changed_at");
CREATE INDEX "work_schedules_store_id_start_at_idx" ON "work_schedules" ("store_id", "start_at");
CREATE INDEX "work_schedule_histories_work_schedule_id_changed_at_idx" ON "work_schedule_histories" ("work_schedule_id", "changed_at");
CREATE INDEX "attendance_records_staff_member_id_recorded_at_idx" ON "attendance_records" ("staff_member_id", "recorded_at");
CREATE INDEX "attendance_records_store_id_recorded_at_idx" ON "attendance_records" ("store_id", "recorded_at");
CREATE INDEX "attendance_corrections_attendance_record_id_idx" ON "attendance_corrections" ("attendance_record_id");
CREATE INDEX "todos_store_id_due_date_idx" ON "todos" ("store_id", "due_date");
CREATE INDEX "todo_assignees_staff_member_id_idx" ON "todo_assignees" ("staff_member_id");
CREATE INDEX "todo_status_histories_todo_id_changed_at_idx" ON "todo_status_histories" ("todo_id", "changed_at");
CREATE INDEX "payslips_store_id_period_start_date_idx" ON "payslips" ("store_id", "period_start_date");
CREATE INDEX "payslip_dispatches_payslip_id_idx" ON "payslip_dispatches" ("payslip_id");
CREATE INDEX "payslip_logs_payslip_id_changed_at_idx" ON "payslip_logs" ("payslip_id", "changed_at");
CREATE INDEX "notification_recipients_account_id_idx" ON "notification_recipients" ("account_id");
CREATE INDEX "notification_recipients_admin_account_id_idx" ON "notification_recipients" ("admin_account_id");
CREATE INDEX "notification_recipients_notification_id_idx" ON "notification_recipients" ("notification_id");
CREATE INDEX "notification_deliveries_notification_recipient_id_idx" ON "notification_deliveries" ("notification_recipient_id");
CREATE INDEX "notification_template_histories_notification_template_id_idx" ON "notification_template_histories" ("notification_template_id");
CREATE INDEX "staff_member_retirement_logs_staff_member_id_processed_at_idx" ON "staff_member_retirement_logs" ("staff_member_id", "processed_at");
CREATE INDEX "post_attachments_post_id_idx" ON "post_attachments" ("post_id");
CREATE INDEX "inquiries_bp_code_id_idx" ON "inquiries" ("bp_code_id");
CREATE INDEX "inquiry_replies_inquiry_id_idx" ON "inquiry_replies" ("inquiry_id");

-- ── 주석 ──
COMMENT ON TABLE "identity_verifications" IS '본인인증 이력';
COMMENT ON COLUMN "identity_verifications"."identity_verification_id" IS '본인인증 ID (논리 verification_id)';
COMMENT ON COLUMN "identity_verifications"."account_id" IS '계정';
COMMENT ON COLUMN "identity_verifications"."purpose" IS '인증 목적 — 가입·휴대전화번호 변경';
COMMENT ON COLUMN "identity_verifications"."phone" IS '인증 휴대전화번호';
COMMENT ON COLUMN "identity_verifications"."result" IS '인증 결과';
COMMENT ON COLUMN "identity_verifications"."verified_at" IS '인증 일시';
COMMENT ON TABLE "auth_sessions" IS '접속 상태';
COMMENT ON COLUMN "auth_sessions"."auth_session_id" IS '접속 ID (논리 session_id)';
COMMENT ON COLUMN "auth_sessions"."account_id" IS '계정';
COMMENT ON COLUMN "auth_sessions"."device_identifier" IS '기기 식별 정보 — 한 계정 여러 기기 (논리 device_info)';
COMMENT ON COLUMN "auth_sessions"."refresh_token_hash" IS '갱신 토큰 해시 — sha256. 한 기기 한 행 — 여러 기기 30일 유지 (물리에서 추가)';
COMMENT ON COLUMN "auth_sessions"."issued_at" IS '발급 시각';
COMMENT ON COLUMN "auth_sessions"."last_used_at" IS '마지막 사용 시각 — 만료는 마지막 사용 + 30일 (물리에서 추가)';
COMMENT ON COLUMN "auth_sessions"."expires_at" IS '만료 시각 — 마지막 접속 후 30일';
COMMENT ON COLUMN "auth_sessions"."revoked_at" IS '종료 시각 — 재설정 시 모두 종료';
COMMENT ON TABLE "accounts" IS '계정';
COMMENT ON COLUMN "accounts"."account_id" IS '계정 ID';
COMMENT ON COLUMN "accounts"."email" IS '이메일 아이디 — 로그인 아이디, 고유';
COMMENT ON COLUMN "accounts"."password_hash" IS '비밀번호 해시';
COMMENT ON COLUMN "accounts"."real_name" IS '실명 — 본인인증 값, 수정 불가';
COMMENT ON COLUMN "accounts"."birth_date" IS '생년월일 — 본인인증 값, 수정 불가';
COMMENT ON COLUMN "accounts"."phone" IS '휴대전화번호 — 본인인증, 변경 시 재인증';
COMMENT ON COLUMN "accounts"."connecting_information" IS '동일인 식별값 (논리 ci)';
COMMENT ON COLUMN "accounts"."zip_code" IS '우편번호 — 외부 주소 검색 API 값 (ME-2) (물리에서 추가)';
COMMENT ON COLUMN "accounts"."address" IS '기본주소 — 도로명 주소, 검색 API 값 (물리에서 추가)';
COMMENT ON COLUMN "accounts"."address_detail" IS '상세주소 — 직접 입력 (물리에서 추가)';
COMMENT ON COLUMN "accounts"."status" IS '계정 상태 — 가입 완료·연결 보류·탈퇴, 휴면 없음';
COMMENT ON COLUMN "accounts"."failed_login_count" IS '로그인 실패 횟수 — 5회 잠금';
COMMENT ON COLUMN "accounts"."lock_expires_at" IS '잠금 해제 시각 — 재설정하면 해제 (논리 locked_until)';
COMMENT ON COLUMN "accounts"."created_at" IS '가입 일시 (물리에서 추가)';
COMMENT ON COLUMN "accounts"."updated_at" IS '최근 수정 일시 (물리에서 추가)';
COMMENT ON TABLE "account_change_histories" IS '계정 변경 이력';
COMMENT ON COLUMN "account_change_histories"."account_change_history_id" IS '변경 이력 ID (논리 change_id)';
COMMENT ON COLUMN "account_change_histories"."account_id" IS '계정';
COMMENT ON COLUMN "account_change_histories"."field" IS '변경 항목 — 휴대전화번호·이메일·주소·비밀번호';
COMMENT ON COLUMN "account_change_histories"."before_value" IS '변경 전 값 — 비밀번호는 저장 안 함';
COMMENT ON COLUMN "account_change_histories"."after_value" IS '변경 후 값 — 비밀번호는 저장 안 함';
COMMENT ON COLUMN "account_change_histories"."channel" IS '변경 경로 — 본인·핀 재설정·관리자 초기화';
COMMENT ON COLUMN "account_change_histories"."requested_by" IS '요청 관리자 — 관리자 초기화일 때';
COMMENT ON COLUMN "account_change_histories"."changed_at" IS '변경 일시';
COMMENT ON TABLE "login_histories" IS '로그인 이력';
COMMENT ON COLUMN "login_histories"."login_history_id" IS '로그인 이력 ID (논리 login_id)';
COMMENT ON COLUMN "login_histories"."account_id" IS '계정 — 없는 이메일이면 비움';
COMMENT ON COLUMN "login_histories"."email" IS '시도 이메일';
COMMENT ON COLUMN "login_histories"."is_succeeded" IS '성공 여부 (논리 succeeded)';
COMMENT ON COLUMN "login_histories"."failure_reason" IS '실패 사유 — 안내 문구는 구분 안 함';
COMMENT ON COLUMN "login_histories"."attempted_at" IS '시도 시각';
COMMENT ON TABLE "password_reset_pins" IS '비밀번호 재설정 핀';
COMMENT ON COLUMN "password_reset_pins"."password_reset_pin_id" IS '핀 ID (논리 pin_id)';
COMMENT ON COLUMN "password_reset_pins"."account_id" IS '계정';
COMMENT ON COLUMN "password_reset_pins"."pin_hash" IS '핀 검증값 — 원본 저장 안 함';
COMMENT ON COLUMN "password_reset_pins"."issued_at" IS '발급 시각 — 1분 재발급 제한, 하루 10회';
COMMENT ON COLUMN "password_reset_pins"."expires_at" IS '만료 시각 — 발급 시각부터 10분 (2026-10-08)';
COMMENT ON COLUMN "password_reset_pins"."attempt_count" IS '시도 횟수 — 5회 틀리면 그 핀은 닫힘, 새 핀을 받는다';
COMMENT ON COLUMN "password_reset_pins"."used_at" IS '사용 시각 — 새 비밀번호 저장 때 핀을 다시 검증하고 남김';
COMMENT ON TABLE "location_access_logs" IS '위치정보 확인자료';
COMMENT ON COLUMN "location_access_logs"."location_access_log_id" IS '확인자료 ID (논리 access_log_id)';
COMMENT ON COLUMN "location_access_logs"."account_id" IS '계정 — 대상 직원';
COMMENT ON COLUMN "location_access_logs"."action" IS '처리 구분 — 수집·이용·제공';
COMMENT ON COLUMN "location_access_logs"."occurred_at" IS '처리 일시';
COMMENT ON COLUMN "location_access_logs"."method" IS '수집 방법 — 기기 GPS · 휴대전화 안 판정';
COMMENT ON COLUMN "location_access_logs"."recipient" IS '제공받는 자 — 제공일 때';
COMMENT ON COLUMN "location_access_logs"."purpose" IS '제공 목적 — 제공일 때';
COMMENT ON COLUMN "location_access_logs"."attendance_record_id" IS '출퇴근 기록 — 있을 때 · 출퇴근 장';
COMMENT ON TABLE "staff_members" IS '직원 레코드';
COMMENT ON COLUMN "staff_members"."staff_member_id" IS '직원 레코드 ID';
COMMENT ON COLUMN "staff_members"."store_id" IS '점포';
COMMENT ON COLUMN "staff_members"."account_id" IS '계정 — 가입 전에는 비어 있음';
COMMENT ON COLUMN "staff_members"."candidate_account_id" IS '후보 계정 — 내부 전용, 화면에 안 보임';
COMMENT ON COLUMN "staff_members"."name" IS '이름 — 초안 입력값';
COMMENT ON COLUMN "staff_members"."phone" IS '휴대전화번호 — 초대 기준값';
COMMENT ON COLUMN "staff_members"."employment_type" IS '고용 형태 — 정직원·파트타이머, 계약으로만 바뀜';
COMMENT ON COLUMN "staff_members"."job_title" IS '직무 — 초안 필수 (2026-10-06)';
COMMENT ON COLUMN "staff_members"."hired_date" IS '입사일';
COMMENT ON COLUMN "staff_members"."employment_status" IS '재직 상태 — 재직·퇴직';
COMMENT ON COLUMN "staff_members"."join_status" IS '가입 상태 — 초안·초대 발송·가입 완료';
COMMENT ON COLUMN "staff_members"."retired_date" IS '퇴직일';
COMMENT ON COLUMN "staff_members"."created_at" IS '등록 일시 (물리에서 추가)';
COMMENT ON COLUMN "staff_members"."updated_at" IS '최근 수정 일시 (물리에서 추가)';
COMMENT ON TABLE "staff_tax_profiles" IS '신고 정보';
COMMENT ON COLUMN "staff_tax_profiles"."staff_member_id" IS '직원 레코드 — 1:1';
COMMENT ON COLUMN "staff_tax_profiles"."rrn_encrypted" IS '주민등록번호 — 암호화, 관리자 웹은 마스킹';
COMMENT ON COLUMN "staff_tax_profiles"."bank_code" IS '은행';
COMMENT ON COLUMN "staff_tax_profiles"."payroll_account_number_encrypted" IS '급여 계좌 — 예금주 본인 (논리 account_no_encrypted)';
COMMENT ON COLUMN "staff_tax_profiles"."purpose" IS '수집 목적 — 취득 신고·원천징수·급여 이체';
COMMENT ON COLUMN "staff_tax_profiles"."collected_at" IS '수집 일시';
COMMENT ON COLUMN "staff_tax_profiles"."updated_at" IS '최종 수정 일시 — 계좌 변경은 다음 급여부터';
COMMENT ON TABLE "invitations" IS '초대';
COMMENT ON COLUMN "invitations"."invitation_id" IS '초대 ID';
COMMENT ON COLUMN "invitations"."staff_member_id" IS '직원 레코드 — 재초대로 여러 건';
COMMENT ON COLUMN "invitations"."invitation_type" IS '초대 유형 — 가입 초대·재초대·소속 추가 확인·복귀 확인 (논리 type)';
COMMENT ON COLUMN "invitations"."invitation_token" IS '초대 토큰 — 가입 초대·재초대만 (논리 token)';
COMMENT ON COLUMN "invitations"."channel" IS '수신 채널';
COMMENT ON COLUMN "invitations"."sent_at" IS '발송 일시';
COMMENT ON COLUMN "invitations"."expires_at" IS '만료 일시 — 30일';
COMMENT ON COLUMN "invitations"."status" IS '상태 — 발송·수락·만료·거절';
COMMENT ON COLUMN "invitations"."responded_at" IS '응답 일시';
COMMENT ON COLUMN "invitations"."reject_reason" IS '거절 사유 — 소속 확인 거절';
COMMENT ON TABLE "link_holds" IS '가입 연결 보류';
COMMENT ON COLUMN "link_holds"."link_hold_id" IS '보류 ID (논리 hold_id)';
COMMENT ON COLUMN "link_holds"."invitation_id" IS '초대';
COMMENT ON COLUMN "link_holds"."account_id" IS '보류 계정';
COMMENT ON COLUMN "link_holds"."mismatch_reason" IS '불일치 사유 — 번호 불일치·이름 불일치';
COMMENT ON COLUMN "link_holds"."resolution" IS '처리 결과 — 승인·번호 수정 후 재초대';
COMMENT ON COLUMN "link_holds"."resolved_by" IS '처리 관리자';
COMMENT ON COLUMN "link_holds"."resolved_at" IS '처리 일시';
COMMENT ON COLUMN "link_holds"."created_at" IS '보류 일시 (물리에서 추가)';
COMMENT ON TABLE "staff_member_retirement_logs" IS '퇴직 처리 이력';
COMMENT ON COLUMN "staff_member_retirement_logs"."staff_member_retirement_log_id" IS '퇴직 처리 이력 ID';
COMMENT ON COLUMN "staff_member_retirement_logs"."staff_member_id" IS '직원 레코드';
COMMENT ON COLUMN "staff_member_retirement_logs"."action" IS '처리 종류 — 처리·취소';
COMMENT ON COLUMN "staff_member_retirement_logs"."retired_date" IS '퇴직일 — 처리·취소한 퇴직일';
COMMENT ON COLUMN "staff_member_retirement_logs"."contract_id" IS '앞당긴 근로계약 — 처리 행만, 계약마다 한 줄';
COMMENT ON COLUMN "staff_member_retirement_logs"."previous_contract_end_date" IS '원래 계약 종료일 — 취소 때 되돌림';
COMMENT ON COLUMN "staff_member_retirement_logs"."processed_by" IS '처리 관리자';
COMMENT ON COLUMN "staff_member_retirement_logs"."processed_at" IS '처리 일시 — 같은 처리는 같은 시각';
COMMENT ON TABLE "contracts" IS '근로계약';
COMMENT ON COLUMN "contracts"."contract_id" IS '근로계약 ID';
COMMENT ON COLUMN "contracts"."staff_member_id" IS '직원 레코드';
COMMENT ON COLUMN "contracts"."store_id" IS '근무지';
COMMENT ON COLUMN "contracts"."previous_contract_id" IS '직전 계약 — 재계약일 때';
COMMENT ON COLUMN "contracts"."employment_type" IS '계약 유형 — 정직원·파트타이머 (논리 contract_type)';
COMMENT ON COLUMN "contracts"."contract_method" IS '계약 방식 — ELECTRONIC·PAPER (CTR-23)';
COMMENT ON COLUMN "contracts"."start_date" IS '계약 시작일 — 종료일 비우면 무기한 (논리 start_date·end_date)';
COMMENT ON COLUMN "contracts"."end_date" IS '계약 종료일 — 종료일 비우면 무기한 (논리 start_date·end_date)';
COMMENT ON COLUMN "contracts"."work_terms" IS '근무 조건 — 근무요일(월~일)·시작·종료·휴게, 30분 단위';
COMMENT ON COLUMN "contracts"."weekly_holiday" IS '주휴일 — 근무요일과 함께 초안에서 정한다 (2026-10-06 재영, 컬럼 유지) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."is_health_pension_insured" IS '건강보험·국민연금 가입';
COMMENT ON COLUMN "contracts"."is_employment_injury_insured" IS '고용보험·산재보험 가입';
COMMENT ON COLUMN "contracts"."wage_terms" IS '급여 조건 — 시급·월급·지급일';
COMMENT ON COLUMN "contracts"."status" IS '계약 상태 — 발송 대기·서명 대기·체결 완료·거부·만료·종료';
COMMENT ON COLUMN "contracts"."draft_action" IS '초안 처리 유형 — 가입 초대·소속 추가 확인·복귀 확인·즉시 발송';
COMMENT ON COLUMN "contracts"."sent_at" IS '발송 일시';
COMMENT ON COLUMN "contracts"."sign_deadline_at" IS '날인 기한 — 발송일부터 30일';
COMMENT ON COLUMN "contracts"."resend_count" IS '재발송 횟수';
COMMENT ON COLUMN "contracts"."reject_reason" IS '거부 사유';
COMMENT ON COLUMN "contracts"."created_by" IS '작성 관리자';
COMMENT ON COLUMN "contracts"."created_at" IS '등록 일시 (물리에서 추가)';
COMMENT ON COLUMN "contracts"."updated_at" IS '최근 수정 일시 (물리에서 추가)';
COMMENT ON TABLE "contract_parties" IS '계약 당사자 정보';
COMMENT ON COLUMN "contract_parties"."contract_id" IS '근로계약 — 1:1';
COMMENT ON COLUMN "contract_parties"."entered_name" IS '관리자 입력 이름 (논리 admin_name·admin_phone)';
COMMENT ON COLUMN "contract_parties"."entered_phone" IS '관리자 입력 휴대전화번호 (논리 admin_name·admin_phone)';
COMMENT ON COLUMN "contract_parties"."entered_birth_date" IS '관리자 입력 생년월일 — 만 19세 미만 차단용 (논리 admin_birth_date)';
COMMENT ON COLUMN "contract_parties"."verified_name" IS '본인인증 실명 — 실명이 다르면 실명 반영 (논리 verified_name·birth_date)';
COMMENT ON COLUMN "contract_parties"."verified_birth_date" IS '본인인증 생년월일 — 실명이 다르면 실명 반영 (논리 verified_name·birth_date)';
COMMENT ON COLUMN "contract_parties"."verified_phone" IS '본인인증 휴대전화번호';
COMMENT ON COLUMN "contract_parties"."zip_code" IS '우편번호 — 직원 입력 (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."address" IS '기본주소 — 직원 입력, 검색 API 값 (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."address_detail" IS '상세주소 — 직원 입력 (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."filled_at" IS '반영 일시 — 가입 완료 시 채움';
COMMENT ON TABLE "contract_documents" IS '계약서 파일';
COMMENT ON COLUMN "contract_documents"."contract_document_id" IS '파일 ID';
COMMENT ON COLUMN "contract_documents"."contract_id" IS '근로계약';
COMMENT ON COLUMN "contract_documents"."kind" IS '파일 구분 — 발송 원본·날인 완료본·종이 계약 근로계약서·임금계약서';
COMMENT ON COLUMN "contract_documents"."storage_key" IS '저장 위치';
COMMENT ON COLUMN "contract_documents"."checksum" IS '파일 해시';
COMMENT ON COLUMN "contract_documents"."created_at" IS '생성 일시';
COMMENT ON TABLE "contract_status_histories" IS '계약 상태 이력';
COMMENT ON COLUMN "contract_status_histories"."contract_status_history_id" IS '상태 이력 ID (논리 history_id)';
COMMENT ON COLUMN "contract_status_histories"."contract_id" IS '근로계약';
COMMENT ON COLUMN "contract_status_histories"."from_status" IS '변경 전 상태';
COMMENT ON COLUMN "contract_status_histories"."to_status" IS '변경 후 상태';
COMMENT ON COLUMN "contract_status_histories"."actor" IS '처리 주체 — 관리자·직원·시스템';
COMMENT ON COLUMN "contract_status_histories"."changed_at" IS '변경 일시';
COMMENT ON TABLE "work_schedules" IS '근무스케줄';
COMMENT ON COLUMN "work_schedules"."work_schedule_id" IS '근무스케줄 ID (논리 schedule_id)';
COMMENT ON COLUMN "work_schedules"."staff_member_id" IS '직원 레코드';
COMMENT ON COLUMN "work_schedules"."store_id" IS '근무지';
COMMENT ON COLUMN "work_schedules"."start_at" IS '근무 시작 일시';
COMMENT ON COLUMN "work_schedules"."end_at" IS '근무 종료 일시 — 같은 직원 겹침 차단';
COMMENT ON COLUMN "work_schedules"."break_minutes" IS '휴게시간';
COMMENT ON COLUMN "work_schedules"."work_type" IS '근무 유형 — 주간·오픈·미들·마감';
COMMENT ON COLUMN "work_schedules"."confirm_status" IS '확정 상태 — 확정 전·확정';
COMMENT ON COLUMN "work_schedules"."source_contract_id" IS '기본값 근로계약 — 등록 때 한 번 반영';
COMMENT ON COLUMN "work_schedules"."created_by" IS '등록 관리자';
COMMENT ON COLUMN "work_schedules"."is_deleted" IS '삭제 표시 — 변경 유형에 삭제가 있다 (물리에서 추가)';
COMMENT ON COLUMN "work_schedules"."created_at" IS '등록 일시 (물리에서 추가)';
COMMENT ON COLUMN "work_schedules"."updated_at" IS '최근 수정 일시 (물리에서 추가)';
COMMENT ON TABLE "work_schedule_histories" IS '근무스케줄 변경 이력';
COMMENT ON COLUMN "work_schedule_histories"."work_schedule_history_id" IS '변경 이력 ID (논리 history_id)';
COMMENT ON COLUMN "work_schedule_histories"."work_schedule_id" IS '근무스케줄 (논리 schedule_id)';
COMMENT ON COLUMN "work_schedule_histories"."change_type" IS '변경 유형 — 등록·수정·삭제';
COMMENT ON COLUMN "work_schedule_histories"."before_value" IS '변경 전 값';
COMMENT ON COLUMN "work_schedule_histories"."after_value" IS '변경 후 값';
COMMENT ON COLUMN "work_schedule_histories"."changed_by" IS '변경 주체';
COMMENT ON COLUMN "work_schedule_histories"."changed_at" IS '변경 일시';
COMMENT ON TABLE "location_consents" IS '위치정보 동의';
COMMENT ON COLUMN "location_consents"."location_consent_id" IS '동의 ID (논리 consent_id)';
COMMENT ON COLUMN "location_consents"."account_id" IS '계정';
COMMENT ON COLUMN "location_consents"."consent_version" IS '동의 문구 버전 (논리 terms_version)';
COMMENT ON COLUMN "location_consents"."agreed_at" IS '동의 일시 — 첫 출퇴근 등록 때';
COMMENT ON COLUMN "location_consents"."paused_at" IS '일시 중지 시각 — 위치 수집 일시 중지 (ATT-26, 2026-09-29). 다시 켜면 NULL (물리에서 추가)';
COMMENT ON COLUMN "location_consents"."withdrawn_at" IS '철회 일시';
COMMENT ON TABLE "attendance_records" IS '출퇴근 기록';
COMMENT ON COLUMN "attendance_records"."attendance_record_id" IS '출퇴근 기록 ID';
COMMENT ON COLUMN "attendance_records"."staff_member_id" IS '직원 레코드';
COMMENT ON COLUMN "attendance_records"."store_id" IS '근무지 — 여럿이면 가장 가까운 곳';
COMMENT ON COLUMN "attendance_records"."kind" IS '구분 — 출근·퇴근';
COMMENT ON COLUMN "attendance_records"."recorded_at" IS '기록 시각 — 기기 시각';
COMMENT ON COLUMN "attendance_records"."received_at" IS '서버 수신 시각 — 확정 기준';
COMMENT ON COLUMN "attendance_records"."review_reason" IS '확인 필요 사유 — 오차 초과·반경 밖 퇴근·위치 조작, 검토 후 null';
COMMENT ON COLUMN "attendance_records"."reviewed_by" IS '검토 관리자 — 보정 또는 이상 없음';
COMMENT ON COLUMN "attendance_records"."reviewed_at" IS '검토 일시';
COMMENT ON COLUMN "attendance_records"."entry_method" IS '등록 방식 — 직원 등록·대신 등록';
COMMENT ON COLUMN "attendance_records"."proxy_by" IS '대신 등록 관리자 — 대신 등록일 때';
COMMENT ON COLUMN "attendance_records"."proxy_reason" IS '대신 등록 사유 — 대신 등록일 때 필수';
COMMENT ON COLUMN "attendance_records"."has_unsigned_warning" IS '계약 미체결 경고 — 경고 후 허용';
COMMENT ON COLUMN "attendance_records"."check_in_attendance_record_id" IS '짝 출근 기록 — 퇴근일 때 (논리 clock_in_id)';
COMMENT ON TABLE "attendance_corrections" IS '출퇴근 보정 이력';
COMMENT ON COLUMN "attendance_corrections"."attendance_correction_id" IS '보정 이력 ID (논리 correction_id)';
COMMENT ON COLUMN "attendance_corrections"."attendance_record_id" IS '출퇴근 기록';
COMMENT ON COLUMN "attendance_corrections"."before_value" IS '수정 전 값';
COMMENT ON COLUMN "attendance_corrections"."after_value" IS '수정 후 값';
COMMENT ON COLUMN "attendance_corrections"."reason" IS '수정 사유 — 필수';
COMMENT ON COLUMN "attendance_corrections"."corrected_by" IS '수정 관리자 — 최근 3개월만';
COMMENT ON COLUMN "attendance_corrections"."corrected_at" IS '수정 일시';
COMMENT ON TABLE "todos" IS 'TO-DO';
COMMENT ON COLUMN "todos"."todo_id" IS 'TO-DO ID';
COMMENT ON COLUMN "todos"."store_id" IS '근무지';
COMMENT ON COLUMN "todos"."assignment_group_id" IS '배정 그룹 ID — 전체·각자 수행 묶음 (논리 assign_group_id)';
COMMENT ON COLUMN "todos"."title" IS '제목';
COMMENT ON COLUMN "todos"."body" IS '내용';
COMMENT ON COLUMN "todos"."assignee_type" IS '배정 방식 — 개인·전체, 등록 후 변경 불가 (논리 assign_mode)';
COMMENT ON COLUMN "todos"."execution_mode" IS '수행 방식 — 각자·공유, 등록 후 변경 불가 (논리 perform_mode)';
COMMENT ON COLUMN "todos"."due_date" IS '수행 예정 날짜 — 필수, 과거 날짜 불가';
COMMENT ON COLUMN "todos"."due_time" IS '수행 시간 — 선택';
COMMENT ON COLUMN "todos"."is_urgent" IS '긴급 여부 — 강조 표시, 미조치에 셈 (논리 urgent)';
COMMENT ON COLUMN "todos"."status" IS '수행 상태 — 대기·진행 중·완료';
COMMENT ON COLUMN "todos"."performer_staff_member_id" IS '수행자 — 공유 TO-DO (논리 performed_by)';
COMMENT ON COLUMN "todos"."completed_at" IS '완료 일시';
COMMENT ON COLUMN "todos"."created_by" IS '등록 관리자';
COMMENT ON COLUMN "todos"."created_at" IS '등록일';
COMMENT ON COLUMN "todos"."is_deleted" IS '삭제 표시 — 대기일 때만 삭제';
COMMENT ON COLUMN "todos"."updated_at" IS '최근 수정 일시 (물리에서 추가)';
COMMENT ON TABLE "todo_assignees" IS 'TO-DO 배정 대상';
COMMENT ON COLUMN "todo_assignees"."todo_id" IS 'TO-DO';
COMMENT ON COLUMN "todo_assignees"."staff_member_id" IS '직원 레코드 — 퇴직자 배정 불가';
COMMENT ON COLUMN "todo_assignees"."is_completed" IS '완료 여부 (논리 completed)';
COMMENT ON COLUMN "todo_assignees"."completed_at" IS '완료 시각';
COMMENT ON TABLE "todo_status_histories" IS 'TO-DO 상태 이력';
COMMENT ON COLUMN "todo_status_histories"."todo_status_history_id" IS '상태 이력 ID (논리 history_id)';
COMMENT ON COLUMN "todo_status_histories"."todo_id" IS 'TO-DO';
COMMENT ON COLUMN "todo_status_histories"."from_status" IS '변경 전 상태';
COMMENT ON COLUMN "todo_status_histories"."to_status" IS '변경 후 상태';
COMMENT ON COLUMN "todo_status_histories"."is_urgent_changed" IS '긴급 표시 변경 — 긴급 표시 이력 (논리 urgent_changed)';
COMMENT ON COLUMN "todo_status_histories"."changed_by" IS '변경 주체';
COMMENT ON COLUMN "todo_status_histories"."staff_member_id" IS '변경 직원 — 직원이 바꿨을 때. changed_by 와 함께 쓰지 않는다 (물리에서 추가)';
COMMENT ON COLUMN "todo_status_histories"."unassigned_staff_member_id" IS '배정 해제 직원 — 퇴직으로 배정을 풀었을 때 (2026-10-07)';
COMMENT ON COLUMN "todo_status_histories"."changed_at" IS '변경 일시';
COMMENT ON TABLE "payslips" IS '급여명세서';
COMMENT ON COLUMN "payslips"."payslip_id" IS '급여명세서 ID';
COMMENT ON COLUMN "payslips"."staff_member_id" IS '직원 레코드 — 같은 기간 중복 생성 차단';
COMMENT ON COLUMN "payslips"."store_id" IS '근무지';
COMMENT ON COLUMN "payslips"."contract_id" IS '참조 근로계약 — 계약 없으면 초안 없음';
COMMENT ON COLUMN "payslips"."period_start_date" IS '급여 기간 시작일 (논리 period_start·period_end)';
COMMENT ON COLUMN "payslips"."period_end_date" IS '급여 기간 종료일 (논리 period_start·period_end)';
COMMENT ON COLUMN "payslips"."employment_type" IS '계약 유형 (논리 contract_type)';
COMMENT ON COLUMN "payslips"."attendance_start_date" IS '출퇴근 참조 시작일 (논리 attendance_from·to)';
COMMENT ON COLUMN "payslips"."attendance_end_date" IS '출퇴근 참조 종료일 (논리 attendance_from·to)';
COMMENT ON COLUMN "payslips"."status" IS '명세서 상태 — 작성 중·검토 중·확정·발송 완료';
COMMENT ON COLUMN "payslips"."is_premium_applied" IS '연장·야간·휴일 가산 — 적용 여부·명세서마다 정함 (논리 overtime_premium)';
COMMENT ON COLUMN "payslips"."is_withholding_applied" IS '3.3% 원천징수 적용 — 파트타이머는 적용으로 시작, 명세서마다 끈다 (운영 정책 PAY-03) (물리에서 추가)';
COMMENT ON COLUMN "payslips"."gross_pay_amount" IS '지급 총액 (논리 gross_pay)';
COMMENT ON COLUMN "payslips"."total_deduction_amount" IS '공제 총액 (논리 total_deduction)';
COMMENT ON COLUMN "payslips"."net_pay_amount" IS '실지급액 (논리 net_pay)';
COMMENT ON COLUMN "payslips"."confirmed_at" IS '확정 일시';
COMMENT ON COLUMN "payslips"."confirmed_by" IS '확정 관리자';
COMMENT ON COLUMN "payslips"."created_at" IS '생성 일시 (물리에서 추가)';
COMMENT ON COLUMN "payslips"."updated_at" IS '최근 수정 일시 (물리에서 추가)';
COMMENT ON TABLE "payslip_items" IS '명세서 금액 항목';
COMMENT ON COLUMN "payslip_items"."payslip_item_id" IS '항목 ID (논리 item_id)';
COMMENT ON COLUMN "payslip_items"."payslip_id" IS '급여명세서';
COMMENT ON COLUMN "payslip_items"."item_category" IS '항목 구분 — 지급·공제 (논리 category)';
COMMENT ON COLUMN "payslip_items"."payslip_item_master_id" IS '급여 항목 — 항목 이름·구분은 명세서에도 박아 둠';
COMMENT ON COLUMN "payslip_items"."item_name" IS '항목 이름 — 발송 당시 이름을 박아 둔다 — 급여 항목 표가 바뀌어도 발행 문서는 그대로 (물리에서 추가)';
COMMENT ON COLUMN "payslip_items"."is_tax_free" IS '비과세 여부 — 발송 당시 값을 박아 둔다 (물리에서 추가)';
COMMENT ON COLUMN "payslip_items"."calculated_amount" IS '시스템 계산값 — 지급 항목만';
COMMENT ON COLUMN "payslip_items"."adjusted_amount" IS '관리자 수정값';
COMMENT ON COLUMN "payslip_items"."is_entered" IS '입력 여부 — 공제 미입력과 0 구분 (논리 entered)';
COMMENT ON TABLE "payslip_item_masters" IS '급여 항목';
COMMENT ON COLUMN "payslip_item_masters"."payslip_item_master_id" IS '급여 항목 ID';
COMMENT ON COLUMN "payslip_item_masters"."item_code" IS '항목 코드 — 고유, 영문 대문자(예: BASE_PAY)';
COMMENT ON COLUMN "payslip_item_masters"."name" IS '항목 이름';
COMMENT ON COLUMN "payslip_item_masters"."category" IS '구분 — 지급·기본 공제·추가 공제·원천징수';
COMMENT ON COLUMN "payslip_item_masters"."is_tax_free" IS '비과세 여부 — 식대·자가운전보조금·육아수당';
COMMENT ON COLUMN "payslip_item_masters"."is_system_calculated" IS '시스템 계산 여부 — 기본급·주휴수당·연장수당';
COMMENT ON COLUMN "payslip_item_masters"."sort_order" IS '순서';
COMMENT ON COLUMN "payslip_item_masters"."is_active" IS '사용 여부 — 플랫폼 관리자가 관리(PAY-21)';
COMMENT ON TABLE "payslip_review_reasons" IS '검토 대기 사유';
COMMENT ON COLUMN "payslip_review_reasons"."payslip_review_reason_id" IS '사유 ID (논리 reason_id)';
COMMENT ON COLUMN "payslip_review_reasons"."payslip_id" IS '급여명세서';
COMMENT ON COLUMN "payslip_review_reasons"."review_reason" IS '사유 — 출퇴근 누락·계약 만료 후 기록·기간 중 계약 변경·공제 미입력 (논리 reason)';
COMMENT ON COLUMN "payslip_review_reasons"."detail" IS '상세 — 누락 일수 등';
COMMENT ON COLUMN "payslip_review_reasons"."acknowledged_at" IS '확인 일시';
COMMENT ON TABLE "payslip_dispatches" IS '명세서 발송 이력';
COMMENT ON COLUMN "payslip_dispatches"."payslip_dispatch_id" IS '발송 이력 ID (논리 dispatch_id)';
COMMENT ON COLUMN "payslip_dispatches"."payslip_id" IS '급여명세서';
COMMENT ON COLUMN "payslip_dispatches"."channel" IS '발송 채널 — 이메일·앱 푸시';
COMMENT ON COLUMN "payslip_dispatches"."status" IS '발송 상태';
COMMENT ON COLUMN "payslip_dispatches"."sent_at" IS '발송 시각';
COMMENT ON COLUMN "payslip_dispatches"."sent_by" IS '발송자';
COMMENT ON TABLE "payslip_logs" IS '명세서 처리 이력';
COMMENT ON COLUMN "payslip_logs"."payslip_log_id" IS '처리 이력 ID (논리 log_id)';
COMMENT ON COLUMN "payslip_logs"."payslip_id" IS '급여명세서';
COMMENT ON COLUMN "payslip_logs"."log_type" IS '유형 — 초안 생성·수정·확정·확정 취소·발송 (draft·edit·confirm·cancel·send)';
COMMENT ON COLUMN "payslip_logs"."from_status" IS '변경 전 상태 — 상태가 바뀐 경우만';
COMMENT ON COLUMN "payslip_logs"."to_status" IS '변경 후 상태 — 확정 취소는 검토 중으로';
COMMENT ON COLUMN "payslip_logs"."summary" IS '내용 — 저장할 때 시스템이 만든 한 줄. 예: 연장수당 96,000원 → 128,000원';
COMMENT ON COLUMN "payslip_logs"."changed_by" IS '처리 주체';
COMMENT ON COLUMN "payslip_logs"."changed_at" IS '처리 일시';
COMMENT ON TABLE "notifications" IS '알림';
COMMENT ON COLUMN "notifications"."notification_id" IS '알림 ID';
COMMENT ON COLUMN "notifications"."notification_target" IS '알림 대상 구분 — 운영 알림·직원 알림 (논리 audience)';
COMMENT ON COLUMN "notifications"."template_code" IS '템플릿 코드 — 만들 때 쓴 알림 템플릿. 문구는 이 알림에 박아 둠';
COMMENT ON COLUMN "notifications"."related_type" IS '관련 업무 유형 — 문의사항·도입문의·근로계약 등';
COMMENT ON COLUMN "notifications"."related_id" IS '관련 업무 ID';
COMMENT ON COLUMN "notifications"."body" IS '알림 내용';
COMMENT ON COLUMN "notifications"."dedupe_key" IS '중복 방지 키 — 같은 사건·수신자 1회';
COMMENT ON COLUMN "notifications"."is_urgent" IS '긴급 여부 (논리 urgent)';
COMMENT ON COLUMN "notifications"."created_at" IS '생성 시각';
COMMENT ON TABLE "notification_recipients" IS '알림 수신';
COMMENT ON COLUMN "notification_recipients"."notification_recipient_id" IS '수신 ID (논리 recipient_id)';
COMMENT ON COLUMN "notification_recipients"."notification_id" IS '알림';
COMMENT ON COLUMN "notification_recipients"."account_id" IS '수신 계정 — 직원 알림';
COMMENT ON COLUMN "notification_recipients"."admin_account_id" IS '수신 관리자 — 운영 알림';
COMMENT ON COLUMN "notification_recipients"."is_read" IS '읽음 여부';
COMMENT ON COLUMN "notification_recipients"."read_at" IS '읽음 처리 시각';
COMMENT ON COLUMN "notification_recipients"."is_deleted" IS '삭제 표시 — 받은 사람별로 지움';
COMMENT ON COLUMN "notification_recipients"."created_at" IS '생성 일시 (물리에서 추가)';
COMMENT ON TABLE "notification_deliveries" IS '알림 발송 이력';
COMMENT ON COLUMN "notification_deliveries"."notification_delivery_id" IS '발송 이력 ID (논리 delivery_id)';
COMMENT ON COLUMN "notification_deliveries"."notification_recipient_id" IS '알림 수신 (논리 recipient_id)';
COMMENT ON COLUMN "notification_deliveries"."channel" IS '발송 채널 — 앱 푸시·알림톡·이메일';
COMMENT ON COLUMN "notification_deliveries"."sent_at" IS '발송 시각';
COMMENT ON COLUMN "notification_deliveries"."result" IS '발송 결과';
COMMENT ON COLUMN "notification_deliveries"."is_fallback" IS '대체 발송 여부 — 푸시 실패 시 알림톡';
COMMENT ON COLUMN "notification_deliveries"."delivery_batch_id" IS '묶음 발송 ID — 한 번에 보낸 발송 묶음 (논리 batch_id)';
COMMENT ON TABLE "notification_preferences" IS '알림 수신 설정';
COMMENT ON COLUMN "notification_preferences"."account_id" IS '계정';
COMMENT ON COLUMN "notification_preferences"."preference_category" IS '수신 설정 묶음 — 근로계약서·근무스케줄·TO-DO·급여명세서';
COMMENT ON COLUMN "notification_preferences"."is_enabled" IS '수신 여부 — 기본 켬, 계약·급여는 끌 수 없음 (논리 enabled)';
COMMENT ON COLUMN "notification_preferences"."updated_at" IS '변경 시각';
COMMENT ON TABLE "notification_templates" IS '알림 템플릿';
COMMENT ON COLUMN "notification_templates"."notification_template_id" IS '템플릿 ID';
COMMENT ON COLUMN "notification_templates"."template_code" IS '템플릿 코드 — 고유. 등록 때 채널 접두를 채우고 운영자가 정함. 개발자는 이 코드로 부름';
COMMENT ON COLUMN "notification_templates"."channel" IS '발송 채널 — 운영 알림·앱 푸시·메일·알림톡';
COMMENT ON COLUMN "notification_templates"."template_name" IS '템플릿 이름 — 예: 근로계약 날인 알림';
COMMENT ON COLUMN "notification_templates"."preference_category" IS '수신 설정 묶음 — 앱 푸시만. 직원 수신 설정 기준';
COMMENT ON COLUMN "notification_templates"."title" IS '제목 — 알림톡은 비움';
COMMENT ON COLUMN "notification_templates"."body" IS '본문 — #{변수}. 알림톡은 카카오 검수 문구와 같게';
COMMENT ON COLUMN "notification_templates"."variables" IS '변수 목록 — [{이름, 표시 이름, 필수, 예시 값}] 순서대로. 저장 때 본문·제목의 #{변수}가 목록 안에 있는지 검사';
COMMENT ON COLUMN "notification_templates"."kakao_template_code" IS '카카오 템플릿 코드 — 알림톡만';
COMMENT ON COLUMN "notification_templates"."is_active" IS '사용 여부 — 지우지 않고 끔';
COMMENT ON COLUMN "notification_templates"."updated_by" IS '수정 관리자';
COMMENT ON COLUMN "notification_templates"."updated_at" IS '수정 시각';
COMMENT ON TABLE "notification_template_histories" IS '알림 템플릿 변경 이력';
COMMENT ON COLUMN "notification_template_histories"."notification_template_history_id" IS '이력 ID (논리 template_history_id)';
COMMENT ON COLUMN "notification_template_histories"."notification_template_id" IS '템플릿';
COMMENT ON COLUMN "notification_template_histories"."template_code" IS '이전 템플릿 코드';
COMMENT ON COLUMN "notification_template_histories"."channel" IS '이전 발송 채널';
COMMENT ON COLUMN "notification_template_histories"."template_name" IS '이전 템플릿 이름';
COMMENT ON COLUMN "notification_template_histories"."preference_category" IS '이전 수신 설정 묶음';
COMMENT ON COLUMN "notification_template_histories"."kakao_template_code" IS '이전 카카오 템플릿 코드';
COMMENT ON COLUMN "notification_template_histories"."is_active" IS '이전 사용 여부';
COMMENT ON COLUMN "notification_template_histories"."title" IS '이전 제목';
COMMENT ON COLUMN "notification_template_histories"."body" IS '이전 본문';
COMMENT ON COLUMN "notification_template_histories"."variables" IS '이전 변수 목록';
COMMENT ON COLUMN "notification_template_histories"."changed_by" IS '수정 관리자';
COMMENT ON COLUMN "notification_template_histories"."changed_at" IS '수정 시각';
COMMENT ON TABLE "posts" IS '공지사항·FAQ';
COMMENT ON COLUMN "posts"."post_id" IS '게시물 ID';
COMMENT ON COLUMN "posts"."content_type" IS '콘텐츠 유형 — 공지사항·FAQ';
COMMENT ON COLUMN "posts"."title" IS '제목';
COMMENT ON COLUMN "posts"."body" IS '본문';
COMMENT ON COLUMN "posts"."status" IS '게시 상태 — 임시저장·게시·비공개';
COMMENT ON COLUMN "posts"."notice_type" IS '공지사항 유형 — 점검·기능·약관·안내';
COMMENT ON COLUMN "posts"."publish_start_date" IS '게시 시작일 (논리 publish_from·to)';
COMMENT ON COLUMN "posts"."publish_end_date" IS '게시 종료일 (논리 publish_from·to)';
COMMENT ON COLUMN "posts"."is_pinned" IS '상단 고정 여부 — 공지사항만 (논리 pinned)';
COMMENT ON COLUMN "posts"."faq_category_code" IS 'FAQ 카테고리 — FAQ만 (논리 faq_category)';
COMMENT ON COLUMN "posts"."is_deleted" IS '삭제 표시 — 복구 가능, 무기한 보관';
COMMENT ON COLUMN "posts"."updated_by" IS '최종 수정 관리자';
COMMENT ON COLUMN "posts"."updated_at" IS '최종 수정 일시';
COMMENT ON COLUMN "posts"."created_by" IS '등록 관리자 (물리에서 추가)';
COMMENT ON COLUMN "posts"."created_at" IS '등록 일시 (물리에서 추가)';
COMMENT ON TABLE "post_audiences" IS '노출 대상';
COMMENT ON COLUMN "post_audiences"."post_audience_id" IS '노출 대상 ID — 대리키 — 부가서비스 상품을 여럿 고를 수 있게 (물리에서 추가)';
COMMENT ON COLUMN "post_audiences"."post_id" IS '게시물';
COMMENT ON COLUMN "post_audiences"."audience_type" IS '대상 유형 — 비회원·회원·BP·점포·부가서비스';
COMMENT ON COLUMN "post_audiences"."service_code" IS '부가서비스 — 공통코드 SERVICE(1팀), 부가서비스일 때';
COMMENT ON TABLE "post_attachments" IS '첨부파일';
COMMENT ON COLUMN "post_attachments"."post_attachment_id" IS '첨부파일 ID (논리 attachment_id)';
COMMENT ON COLUMN "post_attachments"."post_id" IS '게시물 — 글당 5개';
COMMENT ON COLUMN "post_attachments"."file_name" IS '파일 이름';
COMMENT ON COLUMN "post_attachments"."size_bytes" IS '파일 크기 — 10MB 이하';
COMMENT ON COLUMN "post_attachments"."storage_key" IS '저장 위치';
COMMENT ON COLUMN "post_attachments"."sort_order" IS '순서';
COMMENT ON COLUMN "post_attachments"."is_deleted" IS '삭제 표시 (물리에서 추가)';
COMMENT ON COLUMN "post_attachments"."created_at" IS '등록 일시 (물리에서 추가)';
COMMENT ON TABLE "inquiries" IS '문의사항';
COMMENT ON COLUMN "inquiries"."inquiry_id" IS '문의사항 ID';
COMMENT ON COLUMN "inquiries"."created_by" IS '등록 관리자 — 본인 문의만 보임';
COMMENT ON COLUMN "inquiries"."bp_code_id" IS '대상 BP — scope_id 를 나눔 (물리에서 추가)';
COMMENT ON COLUMN "inquiries"."store_id" IS '대상 점포 — 점포 대상일 때 (물리에서 추가)';
COMMENT ON COLUMN "inquiries"."inquiry_category_code" IS '문의 유형 (논리 category)';
COMMENT ON COLUMN "inquiries"."title" IS '제목';
COMMENT ON COLUMN "inquiries"."body" IS '문의 내용';
COMMENT ON COLUMN "inquiries"."status" IS '답변 상태 — 접수·처리중·답변완료';
COMMENT ON COLUMN "inquiries"."internal_memo" IS '운영자 내부 메모 — 사용자에게 안 보임';
COMMENT ON COLUMN "inquiries"."created_at" IS '등록 시각';
COMMENT ON COLUMN "inquiries"."updated_at" IS '최근 수정 일시 (물리에서 추가)';
COMMENT ON TABLE "inquiry_replies" IS '문의 답변';
COMMENT ON COLUMN "inquiry_replies"."inquiry_reply_id" IS '답변 ID (논리 reply_id)';
COMMENT ON COLUMN "inquiry_replies"."inquiry_id" IS '문의사항 — 답변 이력 전부 보관';
COMMENT ON COLUMN "inquiry_replies"."body" IS '답변 내용';
COMMENT ON COLUMN "inquiry_replies"."replied_by" IS '답변 관리자';
COMMENT ON COLUMN "inquiry_replies"."replied_at" IS '답변 시각';
COMMENT ON TABLE "leads" IS '도입문의';
COMMENT ON COLUMN "leads"."lead_id" IS '도입문의 ID';
COMMENT ON COLUMN "leads"."contact_name" IS '문의자 이름';
COMMENT ON COLUMN "leads"."industry_code" IS '업종 — 목록 선택, 기타는 직접 입력 (논리 industry)';
COMMENT ON COLUMN "leads"."industry_detail" IS '업종 직접 입력 — 업종이 기타일 때 (물리에서 추가)';
COMMENT ON COLUMN "leads"."phone" IS '전화번호 — 휴대전화 아닐 수 있음';
COMMENT ON COLUMN "leads"."email" IS '이메일 — 접수 확인 발송';
COMMENT ON COLUMN "leads"."interests" IS '관심 서비스 — 매장운영·재무관리·프랜차이즈·기타';
COMMENT ON COLUMN "leads"."plan_period_code" IS '도입 예정 시기 — 목록 선택 (논리 plan_period)';
COMMENT ON COLUMN "leads"."body" IS '문의 내용';
COMMENT ON COLUMN "leads"."privacy_agreed_at" IS '개인정보 동의 일시 — 필수';
COMMENT ON COLUMN "leads"."marketing_agreed_at" IS '마케팅 동의 일시 — 선택';
COMMENT ON COLUMN "leads"."status" IS '답변 상태';
COMMENT ON COLUMN "leads"."reply" IS '사용자 노출 답변 — 이메일로 회신';
COMMENT ON COLUMN "leads"."internal_memo" IS '운영자 내부 메모';
COMMENT ON COLUMN "leads"."created_at" IS '접수 일시';
COMMENT ON COLUMN "leads"."consulted_date" IS '상담 완료일 — 1년 뒤 파기';
