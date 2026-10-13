-- enum 타입 설명에 한글을 붙인다 (2026-10-12 재영, 1팀 합의).
-- GET /enums 의 한글 출처를 DB 타입 설명으로 옮긴다. scripts/build-enum-labels.mjs 가 이 설명을 읽는다.
-- 한글은 값 순서대로 ' · ' 로 나눈다. 앞으로 enum 을 만들거나 값을 더하는 마이그레이션은 같은 파일에 COMMENT ON TYPE 을 쓴다.
-- 3팀 한글은 docs/erd-physical/_model.py 의 ENUMS, 1팀 한글은 1팀 마이그레이션 CREATE TYPE 줄의 주석에서 옮겼다.

-- 3팀
COMMENT ON TYPE "account_change_channel" IS '본인 · 핀 재설정 · 관리자 초기화';
COMMENT ON TYPE "account_change_field" IS '휴대전화번호 · 이메일 · 주소 · 비밀번호';
COMMENT ON TYPE "account_login_failure_reason" IS '불일치 · 없는 계정 · 잠금';
COMMENT ON TYPE "account_status" IS '가입 완료 · 연결 보류 · 탈퇴';
COMMENT ON TYPE "attachment_file_type" IS 'JPG · PNG · PDF';
COMMENT ON TYPE "attendance_entry_method" IS '직원 등록 · 대신 등록';
COMMENT ON TYPE "attendance_kind" IS '출근 · 퇴근';
COMMENT ON TYPE "attendance_review_reason" IS '위치 오차 초과 · 반경 밖 퇴근 · 위치 조작 감지';
COMMENT ON TYPE "contract_document_kind" IS '발송 원본 · 날인 완료본 · 종이 계약 근로계약서 · 임금계약서';
COMMENT ON TYPE "contract_draft_action" IS '가입 초대 · 소속 추가 확인 · 복귀 확인 · 즉시 발송';
COMMENT ON TYPE "contract_method" IS '전자계약 · 종이 계약';
COMMENT ON TYPE "contract_status" IS '발송 대기 · 서명 대기 · 체결 완료 · 거부 · 만료 · 종료';
COMMENT ON TYPE "dispatch_result" IS '성공 · 실패';
COMMENT ON TYPE "employment_status" IS '재직 · 퇴직';
COMMENT ON TYPE "employment_type" IS '정직원 · 파트타이머';
COMMENT ON TYPE "identity_verification_purpose" IS '가입 · 휴대전화번호 변경';
COMMENT ON TYPE "identity_verification_result" IS '성공 · 실패';
COMMENT ON TYPE "inquiry_status" IS '접수 · 처리중 · 답변완료';
COMMENT ON TYPE "invitation_channel" IS 'SMS · 알림톡';
COMMENT ON TYPE "invitation_status" IS '발송 · 수락 · 만료 · 거절 · 가입 불가(만 19세 미만)';
COMMENT ON TYPE "invitation_type" IS '가입 초대 · 재초대 · 소속 추가 확인 · 복귀 확인';
COMMENT ON TYPE "lead_interest" IS '매장운영 · 재무관리 · 프랜차이즈 · 기타';
COMMENT ON TYPE "link_hold_mismatch_reason" IS '번호 불일치 · 이름 불일치';
COMMENT ON TYPE "link_hold_resolution" IS '승인 · 번호 수정 후 재초대';
COMMENT ON TYPE "location_access_action" IS '수집 · 이용 · 제공';
COMMENT ON TYPE "notice_type" IS '점검 · 기능 · 약관 · 안내';
COMMENT ON TYPE "notification_channel" IS '앱 푸시 · 알림톡 · 이메일';
COMMENT ON TYPE "notification_target" IS '운영 알림 · 직원 알림';
COMMENT ON TYPE "notification_template_channel" IS '운영 알림 · 앱 푸시 · 메일 · 알림톡';
COMMENT ON TYPE "payslip_dispatch_channel" IS '이메일 · 앱 푸시';
COMMENT ON TYPE "payslip_item_category" IS '지급 · 기본 공제 · 추가 공제 · 원천징수';
COMMENT ON TYPE "payslip_log_type" IS '초안 생성 · 수정 · 확정 · 확정 취소 · 발송';
COMMENT ON TYPE "payslip_review_reason" IS '출퇴근 누락 · 계약 만료 후 기록 · 기간 중 계약 변경 · 공제 미입력';
COMMENT ON TYPE "payslip_status" IS '작성 중 · 검토 중 · 확정 · 발송 완료';
COMMENT ON TYPE "post_audience_type" IS '비회원 · 회원 · BP · 점포 · 부가서비스';
COMMENT ON TYPE "post_content_type" IS '공지사항 · FAQ';
COMMENT ON TYPE "post_status" IS '임시저장 · 게시 · 비공개';
COMMENT ON TYPE "preference_category" IS '근로계약서 · 근무스케줄 · TO-DO · 급여명세서';
COMMENT ON TYPE "retirement_action" IS '처리 · 취소';
COMMENT ON TYPE "staff_member_join_status" IS '초안 · 초대 발송 · 가입 완료';
COMMENT ON TYPE "status_change_actor" IS '관리자 · 직원 · 시스템';
COMMENT ON TYPE "todo_assignee_type" IS '개인 · 근무지 전체';
COMMENT ON TYPE "todo_execution_mode" IS '각자 수행 · 한 명 수행';
COMMENT ON TYPE "todo_status" IS '대기 · 진행 중 · 완료';
COMMENT ON TYPE "weekday" IS '월 · 화 · 수 · 목 · 금 · 토 · 일';
COMMENT ON TYPE "work_schedule_change_type" IS '등록 · 수정 · 삭제';

-- 1팀
COMMENT ON TYPE "login_failure_reason" IS '불일치 · 잠금 · 미사용 · 탈퇴';
COMMENT ON TYPE "process_result" IS '성공 · 실패';
COMMENT ON TYPE "public_holiday_source" IS '규칙 계산 · 공식 API';
COMMENT ON TYPE "repeat_end_type" IS '없음 · 날짜 · 횟수';
COMMENT ON TYPE "store_image_file_type" IS 'JPG · PNG';
COMMENT ON TYPE "temporary_password_purpose" IS '임시비밀번호 · 초기비밀번호 · 비밀번호초기화';
COMMENT ON TYPE "terms_agreement_channel" IS '회원가입 · 최초 로그인 · 재동의 · 약관변경';
COMMENT ON TYPE "use_status" IS '사용 · 사용중지';

-- 이 파일이 설명을 붙인 54개만 확인한다. DB 전체를 보지 않는다 — 공용 DB 에는 저장소에 없는 마이그레이션이 만든
-- enum 이 있을 수 있다(2026-10-12 첫 적용이 pay_month 때문에 실패했다).
DO $$
DECLARE
    missing text;
BEGIN
    SELECT string_agg(n, ', ') INTO missing
      FROM unnest(ARRAY[
        'account_change_channel', 'account_change_field', 'account_login_failure_reason', 'account_status', 'attachment_file_type', 'attendance_entry_method',
        'attendance_kind', 'attendance_review_reason', 'contract_document_kind', 'contract_draft_action', 'contract_method', 'contract_status',
        'dispatch_result', 'employment_status', 'employment_type', 'identity_verification_purpose', 'identity_verification_result', 'inquiry_status',
        'invitation_channel', 'invitation_status', 'invitation_type', 'lead_interest', 'link_hold_mismatch_reason', 'link_hold_resolution',
        'location_access_action', 'notice_type', 'notification_channel', 'notification_target', 'notification_template_channel', 'payslip_dispatch_channel',
        'payslip_item_category', 'payslip_log_type', 'payslip_review_reason', 'payslip_status', 'post_audience_type', 'post_content_type',
        'post_status', 'preference_category', 'retirement_action', 'staff_member_join_status', 'status_change_actor', 'todo_assignee_type',
        'todo_execution_mode', 'todo_status', 'weekday', 'work_schedule_change_type', 'login_failure_reason', 'process_result',
        'public_holiday_source', 'repeat_end_type', 'store_image_file_type', 'temporary_password_purpose', 'terms_agreement_channel', 'use_status'
      ]) AS n
     WHERE obj_description(to_regtype(quote_ident(n)), 'pg_type') IS NULL;
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION '한글 설명이 없는 enum: %', missing;
    END IF;
END $$;
