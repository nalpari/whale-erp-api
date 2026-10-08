"""3팀 물리 모델의 결정 — 논리 카탈로그(front docs/erd/README.md)를 물리로 옮길 때 바꾸는 것.

논리 카탈로그는 front 소유라 여기서 고치지 않는다. 네이밍 규칙과 어긋나는 이름, 한 줄에 두 컬럼을
적은 행, 논리 ERD 이후 정해진 결정은 아래 표로 물리에서만 바꾸고, 바꾼 내역은 정의서에 그대로 남는다.
"""

# ─── 논리 → 물리 이름 ──────────────────────────────────────────────────────
# (테이블, 논리 컬럼) → 물리 컬럼. 이유는 RENAME_WHY 의 분류로 정의서에 나온다.
RENAME = {
    # 기본키 {참조 단수}_id (네이밍 규칙 2026-10-02)
    ("identity_verifications", "verification_id"): "identity_verification_id",
    ("auth_sessions", "session_id"): "auth_session_id",
    ("auth_sessions", "device_info"): "device_identifier",
    ("account_change_histories", "change_id"): "account_change_history_id",
    ("login_histories", "login_id"): "login_history_id",
    ("password_reset_pins", "pin_id"): "password_reset_pin_id",
    ("location_access_logs", "access_log_id"): "location_access_log_id",
    ("link_holds", "hold_id"): "link_hold_id",
    ("contract_status_histories", "history_id"): "contract_status_history_id",
    ("work_schedules", "schedule_id"): "work_schedule_id",
    ("work_schedule_histories", "history_id"): "work_schedule_history_id",
    ("work_schedule_histories", "schedule_id"): "work_schedule_id",
    ("location_consents", "consent_id"): "location_consent_id",
    ("attendance_corrections", "correction_id"): "attendance_correction_id",
    ("todo_status_histories", "history_id"): "todo_status_history_id",
    ("payslip_items", "item_id"): "payslip_item_id",
    ("payslip_review_reasons", "reason_id"): "payslip_review_reason_id",
    ("payslip_dispatches", "dispatch_id"): "payslip_dispatch_id",
    ("payslip_logs", "log_id"): "payslip_log_id",
    ("notification_recipients", "recipient_id"): "notification_recipient_id",
    ("notification_deliveries", "delivery_id"): "notification_delivery_id",
    ("notification_deliveries", "recipient_id"): "notification_recipient_id",
    ("post_attachments", "attachment_id"): "post_attachment_id",
    ("inquiry_replies", "reply_id"): "inquiry_reply_id",
    # 참·거짓은 is_ · has_
    ("login_histories", "succeeded"): "is_succeeded",
    ("todos", "urgent"): "is_urgent",
    ("todo_assignees", "completed"): "is_completed",
    ("todo_status_histories", "urgent_changed"): "is_urgent_changed",
    ("payslip_items", "entered"): "is_entered",
    ("notifications", "urgent"): "is_urgent",
    ("notification_preferences", "enabled"): "is_enabled",
    ("posts", "pinned"): "is_pinned",
    ("payslips", "overtime_premium"): "is_premium_applied",
    # 시각은 _at
    ("accounts", "locked_until"): "lock_expires_at",
    # 금액은 _amount
    ("payslips", "gross_pay"): "gross_pay_amount",
    ("payslips", "total_deduction"): "total_deduction_amount",
    ("payslips", "net_pay"): "net_pay_amount",
    # 약어 금지
    ("accounts", "ci"): "connecting_information",
    ("staff_tax_profiles", "account_no_encrypted"): "payroll_account_number_encrypted",
    # 대응표의 영문 식별자
    ("contracts", "contract_type"): "employment_type",
    ("payslips", "contract_type"): "employment_type",
    ("invitations", "type"): "invitation_type",
    ("invitations", "token"): "invitation_token",
    ("location_consents", "terms_version"): "consent_version",
    ("todos", "assign_group_id"): "assignment_group_id",
    ("todos", "assign_mode"): "assignee_type",
    ("todos", "perform_mode"): "execution_mode",
    ("todos", "performed_by"): "performer_staff_member_id",
    ("attendance_records", "clock_in_id"): "check_in_attendance_record_id",
    ("payslip_items", "category"): "item_category",
    ("payslip_review_reasons", "reason"): "review_reason",
    ("notifications", "audience"): "notification_target",
    ("notification_template_histories", "template_history_id"): "notification_template_history_id",
    ("notification_deliveries", "batch_id"): "delivery_batch_id",
    ("posts", "faq_category"): "faq_category_code",
    ("inquiries", "category"): "inquiry_category_code",
    ("leads", "industry"): "industry_code",
    ("leads", "plan_period"): "plan_period_code",
    ("staff_tax_profiles", "bank_code"): "bank_code",
    ("contract_parties", "address"): "address",
}

RENAME_WHY = [
    ("기본키 {참조 단수}_id", lambda t, a, b: b.endswith("_id") and a.endswith("_id")),
    ("참·거짓 is_·has_", lambda t, a, b: b.startswith(("is_", "has_"))),
    ("시각 _at", lambda t, a, b: b.endswith("_at")),
    ("금액 _amount", lambda t, a, b: b.endswith("_amount")),
    ("약어 금지", lambda t, a, b: a in ("ci", "account_no_encrypted", "device_info")),
]

# 한 줄에 두 컬럼을 적은 논리 행 → 물리 컬럼들 (이름, 속성명)
SPLIT = {
    ("contracts", "start_date·end_date"): [("start_date", "계약 시작일"), ("end_date", "계약 종료일")],
    ("contract_parties", "admin_name·admin_phone"): [("entered_name", "관리자 입력 이름"),
                                                     ("entered_phone", "관리자 입력 휴대전화번호")],
    ("contract_parties", "verified_name·birth_date"): [("verified_name", "본인인증 실명"),
                                                       ("verified_birth_date", "본인인증 생년월일")],
    ("payslips", "period_start·period_end"): [("period_start_date", "급여 기간 시작일"),
                                              ("period_end_date", "급여 기간 종료일")],
    ("payslips", "attendance_from·to"): [("attendance_start_date", "출퇴근 참조 시작일"),
                                         ("attendance_end_date", "출퇴근 참조 종료일")],
    ("posts", "publish_from·to"): [("publish_start_date", "게시 시작일"), ("publish_end_date", "게시 종료일")],
}
# SPLIT 뒤 물리 이름을 다시 정한 것
RENAME.update({("contract_parties", "admin_birth_date"): "entered_birth_date"})

# 논리 타입을 물리에서 바꾼 것 (테이블, 물리 컬럼) → (논리 타입, 이유)
LTYPE = {
    ("staff_tax_profiles", "bank_code"): ("code", "공통코드 BANK — 은행 목록은 운영 중 바뀐다"),
    ("notifications", "related_type"): ("text", "관련 업무 종류가 열려 있다(… 등). 외래키 없는 다형 참조"),
    ("posts", "faq_category_code"): ("code", "목록 선택 — 공통코드"),
    ("post_audiences", "service_code"): ("code", "1팀 공통코드 SERVICE — 부가서비스만 거를 기준은 1팀에 묻는 중 (2026-10-07 재영)"),
    ("inquiries", "inquiry_category_code"): ("code", "목록 선택 — 공통코드"),
    ("leads", "industry_code"): ("code", "목록 선택 — 공통코드, 기타는 industry_detail"),
    ("leads", "plan_period_code"): ("code", "목록 선택 — 공통코드"),
    ("work_schedule_histories", "changed_by"): ("id", "관리자 외래키 {역할}_by"),
    ("payslip_logs", "changed_by"): ("id", "관리자 외래키 {역할}_by, 시스템 처리면 NULL"),
    ("todo_status_histories", "changed_by"): ("id", "관리자 외래키 {역할}_by, 직원이 바꾸면 NULL"),
}

# 물리에서 뺀 논리 컬럼 → 이유
DROP = {
    ("inquiries", "scope_id"): "대상이 BP 또는 점포인 다형 참조라 외래키를 걸 수 없다 → bp_code_id · store_id 두 칸으로 나눔",
    ("notification_deliveries", "scheduled_at"): "근무시간 외 보류 규칙이 없어졌다 (NOTI-1, 2026-09-28). 보류 큐를 만들지 않는다",
    ("accounts", "address"): "주소를 기본·상세로 나눠 둔다 (ME-2, 2026-09-17 개발 판단 요청) → zip_code · address · address_detail",
    ("contract_parties", "address"): "accounts 와 같이 기본·상세로 나눈다 → zip_code · address · address_detail",
}

# 물리에서 더한 컬럼: 테이블 → [(이 컬럼 뒤에 · None 이면 끝 · "^" 면 맨 앞, 키, 속성명, 논리 타입, 컬럼, 비고)]
ADD = {
    "auth_sessions": [("device_identifier", "", "갱신 토큰 해시", "hash", "refresh_token_hash", "sha256. 한 기기 한 행 — 여러 기기 30일 유지"),
                      ("issued_at", "", "마지막 사용 시각", "datetime", "last_used_at", "만료는 마지막 사용 + 30일")],
    "accounts": [("connecting_information", "", "우편번호", "text", "zip_code", "외부 주소 검색 API 값 (ME-2)"),
                 ("zip_code", "", "기본주소", "text", "address", "도로명 주소, 검색 API 값"),
                 ("address", "", "상세주소", "text", "address_detail", "직접 입력"),
                 (None, "", "가입 일시", "datetime", "created_at", ""),
                 (None, "", "최근 수정 일시", "datetime", "updated_at", "")],
    "staff_members": [(None, "", "등록 일시", "datetime", "created_at", ""),
                      (None, "", "최근 수정 일시", "datetime", "updated_at", "")],
    "link_holds": [(None, "", "보류 일시", "datetime", "created_at", "")],
    "contracts": [("work_terms", "", "주휴일", "enum", "weekly_holiday", "근무요일과 함께 초안에서 정한다 (2026-10-06 재영, 컬럼 유지)"),
                  (None, "", "등록 일시", "datetime", "created_at", ""),
                  (None, "", "최근 수정 일시", "datetime", "updated_at", "")],
    "contract_parties": [("verified_phone", "", "우편번호", "text", "zip_code", "직원 입력"),
                         ("zip_code", "", "기본주소", "text", "address", "직원 입력, 검색 API 값"),
                         ("address", "", "상세주소", "text", "address_detail", "직원 입력")],
    "work_schedules": [(None, "", "삭제 표시", "bool", "is_deleted", "변경 유형에 삭제가 있다"),
                       (None, "", "등록 일시", "datetime", "created_at", ""),
                       (None, "", "최근 수정 일시", "datetime", "updated_at", "")],
    "location_consents": [("agreed_at", "", "일시 중지 시각", "datetime", "paused_at", "위치 수집 일시 중지 (ATT-26, 2026-09-29). 다시 켜면 NULL")],
    "todos": [(None, "", "최근 수정 일시", "datetime", "updated_at", "")],
    "todo_status_histories": [("changed_by", "FK", "변경 직원", "id", "staff_member_id", "직원이 바꿨을 때. changed_by 와 함께 쓰지 않는다")],
    "payslips": [("is_premium_applied", "", "3.3% 원천징수 적용", "bool", "is_withholding_applied", "파트타이머는 적용으로 시작, 명세서마다 끈다 (운영 정책 PAY-03)"),
                 (None, "", "생성 일시", "datetime", "created_at", ""),
                 (None, "", "최근 수정 일시", "datetime", "updated_at", "")],
    "payslip_items": [("payslip_item_master_id", "", "항목 이름", "text", "item_name", "발송 당시 이름을 박아 둔다 — 급여 항목 표가 바뀌어도 발행 문서는 그대로"),
                      ("item_name", "", "비과세 여부", "bool", "is_tax_free", "발송 당시 값을 박아 둔다")],
    "notification_recipients": [(None, "", "생성 일시", "datetime", "created_at", "")],
    "posts": [(None, "FK", "등록 관리자", "id", "created_by", ""),
              (None, "", "등록 일시", "datetime", "created_at", "")],
    "post_audiences": [("^", "PK", "노출 대상 ID", "id", "post_audience_id", "대리키 — 부가서비스 상품을 여럿 고를 수 있게")],
    "post_attachments": [(None, "", "삭제 표시", "bool", "is_deleted", ""),
                         (None, "", "등록 일시", "datetime", "created_at", "")],
    "inquiries": [("created_by", "FK", "대상 BP", "id", "bp_code_id", "scope_id 를 나눔"),
                  ("bp_code_id", "FK", "대상 점포", "id", "store_id", "점포 대상일 때"),
                  (None, "", "최근 수정 일시", "datetime", "updated_at", "")],
    "leads": [("industry_code", "", "업종 직접 입력", "text", "industry_detail", "업종이 기타일 때")],
}

# 논리 PK 를 일반 컬럼으로 내린다 — post_audiences 는 대리키를 새로 둔다
DEMOTE_PK = {("post_audiences", "post_id"), ("post_audiences", "audience_type")}

# 1팀 소유 — 만들지 않고 참조만 한다 (테이블 → PK)
# 3팀 DDL 마이그레이션(prisma/migrations/20261007000000_team3_initial)을 어느 DB 에든 적용했으면 True.
# True 가 되면 생성기는 그 파일을 덮어쓰지 않고, 내용이 달라지면 멈춘다 — 그때부터 바꿀 것은 새 마이그레이션으로.
MIGRATION_APPLIED = True  # 2026-10-07 개발 DB(whale-erp)에 db:deploy

EXTERNAL = {"stores": "store_id", "bp_codes": "bp_code_id", "admin_accounts": "admin_account_id"}

# 외래키 컬럼 → 참조 테이블. 이 표에 있는 이름은 모두 외래키다(자기 PK 제외).
FK_TARGET = {
    "account_id": "accounts", "candidate_account_id": "accounts",
    "store_id": "stores", "bp_code_id": "bp_codes", "admin_account_id": "admin_accounts",
    "staff_member_id": "staff_members", "performer_staff_member_id": "staff_members",
    "unassigned_staff_member_id": "staff_members",
    "invitation_id": "invitations",
    "contract_id": "contracts", "previous_contract_id": "contracts", "source_contract_id": "contracts",
    "work_schedule_id": "work_schedules",
    "attendance_record_id": "attendance_records", "check_in_attendance_record_id": "attendance_records",
    "todo_id": "todos", "payslip_id": "payslips",
    "notification_id": "notifications", "notification_recipient_id": "notification_recipients",
    "post_id": "posts", "inquiry_id": "inquiries", "payslip_item_master_id": "payslip_item_masters",
    "notification_template_id": "notification_templates",
    # 관리자 외래키 {역할}_by
    **{c: "admin_accounts" for c in ("created_by", "updated_by", "changed_by", "requested_by", "resolved_by",
                                     "reviewed_by", "proxy_by", "corrected_by", "confirmed_by", "sent_by",
                                     "replied_by", "processed_by")},
}

# 논리 PK 를 그대로 두는 테이블 (1:1 · 복합 PK)
KEEP_PK = {"staff_tax_profiles", "contract_parties", "todo_assignees", "notification_preferences"}

# enum: (테이블, 물리 컬럼) → (타입, 값, 한글). 대응표에 있는 값은 대응표를 따르고, 없는 값은 이 문서가 제안한다.
_EMPLOY = ("employment_type", ["FULL_TIME", "PART_TIME"], "정직원 · 파트타이머")
_CSTATUS = ("contract_status", ["PENDING_SEND", "PENDING_SIGNATURE", "SIGNED", "REJECTED", "EXPIRED", "ENDED"],
            "발송 대기 · 서명 대기 · 체결 완료 · 거부 · 만료 · 종료")
_ACTOR = ("status_change_actor", ["ADMIN", "STAFF", "SYSTEM"], "관리자 · 직원 · 시스템")
_TODO = ("todo_status", ["PENDING", "IN_PROGRESS", "DONE"], "대기 · 진행 중 · 완료")
_PAY = ("payslip_status", ["DRAFTING", "REVIEWING", "CONFIRMED", "SENT"], "작성 중 · 검토 중 · 확정 · 발송 완료")
_SEND = ("dispatch_result", ["SUCCEEDED", "FAILED"], "성공 · 실패")
_INQ = ("inquiry_status", ["RECEIVED", "IN_PROGRESS", "ANSWERED"], "접수 · 처리중 · 답변완료")
ENUMS = {
    ("identity_verifications", "purpose"): ("identity_verification_purpose", ["SIGNUP", "PHONE_CHANGE"], "가입 · 휴대전화번호 변경"),
    ("identity_verifications", "result"): ("identity_verification_result", ["SUCCEEDED", "FAILED"], "성공 · 실패"),
    ("accounts", "status"): ("account_status", ["JOINED", "LINK_HOLD"], "가입 완료 · 연결 보류"),
    ("account_change_histories", "field"): ("account_change_field", ["PHONE", "EMAIL", "ADDRESS", "PASSWORD"],
                                            "휴대전화번호 · 이메일 · 주소 · 비밀번호"),
    ("account_change_histories", "channel"): ("account_change_channel", ["SELF", "PIN_RESET", "ADMIN_RESET"],
                                              "본인 · 핀 재설정 · 관리자 초기화"),
    ("login_histories", "failure_reason"): ("account_login_failure_reason", ["PASSWORD_MISMATCH", "ACCOUNT_NOT_FOUND", "LOCKED"],
                                            "불일치 · 없는 계정 · 잠금"),
    ("location_access_logs", "action"): ("location_access_action", ["COLLECT", "USE", "PROVIDE"], "수집 · 이용 · 제공"),
    ("staff_members", "employment_type"): _EMPLOY,
    ("staff_members", "employment_status"): ("employment_status", ["EMPLOYED", "RETIRED"], "재직 · 퇴직"),
    ("staff_members", "join_status"): ("staff_member_join_status", ["DRAFT", "INVITED", "JOINED"], "초안 · 초대 발송 · 가입 완료"),
    ("invitations", "invitation_type"): ("invitation_type", ["SIGNUP", "REINVITE", "AFFILIATION_CONFIRM", "RETURN_CONFIRM"],
                                         "가입 초대 · 재초대 · 소속 추가 확인 · 복귀 확인"),
    ("invitations", "channel"): ("invitation_channel", ["SMS", "ALIMTALK"], "SMS · 알림톡"),
    ("invitations", "status"): ("invitation_status", ["SENT", "ACCEPTED", "EXPIRED", "REJECTED", "REJECTED_UNDER_AGE"],
                                "발송 · 수락 · 만료 · 거절 · 가입 불가(만 19세 미만)"),
    ("link_holds", "mismatch_reason"): ("link_hold_mismatch_reason", ["PHONE_MISMATCH", "NAME_MISMATCH"], "번호 불일치 · 이름 불일치"),
    ("link_holds", "resolution"): ("link_hold_resolution", ["APPROVED", "REINVITED"], "승인 · 번호 수정 후 재초대"),
    ("contracts", "employment_type"): _EMPLOY,
    ("contracts", "contract_method"): ("contract_method", ["ELECTRONIC", "PAPER"], "전자계약 · 종이 계약"),
    ("contracts", "weekly_holiday"): ("weekday", ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], "월 · 화 · 수 · 목 · 금 · 토 · 일"),
    ("contracts", "status"): _CSTATUS,
    ("contracts", "draft_action"): ("contract_draft_action", ["SIGNUP_INVITE", "AFFILIATION_CONFIRM", "RETURN_CONFIRM", "IMMEDIATE_SEND"],
                                    "가입 초대 · 소속 추가 확인 · 복귀 확인 · 즉시 발송"),
    ("contract_documents", "kind"): ("contract_document_kind", ["SENT_ORIGINAL", "SIGNED_COPY", "PAPER_EMPLOYMENT_CONTRACT", "WAGE_CONTRACT"],
                                     "발송 원본 · 날인 완료본 · 종이 계약 근로계약서 · 임금계약서"),
    ("contract_status_histories", "from_status"): _CSTATUS,
    ("contract_status_histories", "to_status"): _CSTATUS,
    ("contract_status_histories", "actor"): _ACTOR,
    ("work_schedules", "work_type"): ("work_type", ["DAY", "OPEN", "MIDDLE", "CLOSE"], "주간 · 오픈 · 미들 · 마감"),  # 주간 추가 (2026-10-07 재영, HOME-6)
    ("work_schedules", "confirm_status"): ("work_schedule_confirm_status", ["UNCONFIRMED", "CONFIRMED"], "확정 전 · 확정"),
    ("work_schedule_histories", "change_type"): ("work_schedule_change_type", ["CREATED", "UPDATED", "DELETED"], "등록 · 수정 · 삭제"),
    ("attendance_records", "kind"): ("attendance_kind", ["CHECK_IN", "CHECK_OUT"], "출근 · 퇴근"),
    ("attendance_records", "review_reason"): ("attendance_review_reason", ["ACCURACY_EXCEEDED", "OUT_OF_RADIUS_CHECKOUT", "MOCK_LOCATION"],
                                              "위치 오차 초과 · 반경 밖 퇴근 · 위치 조작 감지"),
    ("attendance_records", "entry_method"): ("attendance_entry_method", ["SELF", "PROXY"], "직원 등록 · 대신 등록"),
    ("todos", "assignee_type"): ("todo_assignee_type", ["INDIVIDUAL", "ALL"], "개인 · 근무지 전체"),
    ("todos", "execution_mode"): ("todo_execution_mode", ["EACH", "ANY_ONE"], "각자 수행 · 한 명 수행"),
    ("todos", "status"): _TODO,
    ("todo_status_histories", "from_status"): _TODO,
    ("todo_status_histories", "to_status"): _TODO,
    ("payslips", "employment_type"): _EMPLOY,
    ("payslips", "status"): _PAY,
    # 급여 항목 구분 4종 (2026-10-07 재영). 명세서 줄의 구분은 발송 당시 항목 표의 구분을 박아 둔 값이라 같은 enum 을 쓴다
    ("payslip_item_masters", "category"): ("payslip_item_category", ["EARNING", "BASIC", "ADDITIONAL", "WITHHOLDING"],
                                           "지급 · 기본 공제 · 추가 공제 · 원천징수"),
    ("payslip_items", "item_category"): ("payslip_item_category", ["EARNING", "BASIC", "ADDITIONAL", "WITHHOLDING"],
                                         "지급 · 기본 공제 · 추가 공제 · 원천징수"),
    ("payslip_review_reasons", "review_reason"): ("payslip_review_reason", ["MISSING_ATTENDANCE", "AFTER_CONTRACT_END", "CONTRACT_CHANGED", "DEDUCTION_MISSING"],
                                                  "출퇴근 누락 · 계약 만료 후 기록 · 기간 중 계약 변경 · 공제 미입력"),
    ("payslip_dispatches", "channel"): ("payslip_dispatch_channel", ["EMAIL", "PUSH"], "이메일 · 앱 푸시"),
    ("payslip_dispatches", "status"): _SEND,
    ("payslip_logs", "log_type"): ("payslip_log_type", ["DRAFT", "EDIT", "CONFIRM", "CANCEL_CONFIRMATION", "SEND"],
                                   "초안 생성 · 수정 · 확정 · 확정 취소 · 발송"),
    ("payslip_logs", "from_status"): _PAY,
    ("payslip_logs", "to_status"): _PAY,
    ("notifications", "notification_target"): ("notification_target", ["ADMIN", "STAFF"], "운영 알림 · 직원 알림"),
    ("notification_deliveries", "channel"): ("notification_channel", ["PUSH", "ALIMTALK", "EMAIL"], "앱 푸시 · 알림톡 · 이메일"),
    ("notification_deliveries", "result"): _SEND,
    # 알림톡 발송 이력 — 비즈뿌리오 접수 기준 (2026-10-08)
    ("alimtalk_send_logs", "result"): _SEND,
    # 퇴직 처리 (2026-10-07 재영, 운영 정책 CTR-24 · CTR-25)
    ("staff_member_retirement_logs", "action"): ("retirement_action", ["RETIRE", "CANCEL"], "처리 · 취소"),
    ("notification_templates", "preference_category"): ("preference_category", ["CONTRACT", "SCHEDULE", "TODO", "PAYSLIP"], "근로계약서 · 근무스케줄 · TO-DO · 급여명세서"),
    ("notification_template_histories", "preference_category"): ("preference_category", ["CONTRACT", "SCHEDULE", "TODO", "PAYSLIP"], "근로계약서 · 근무스케줄 · TO-DO · 급여명세서"),
    ("notification_preferences", "preference_category"): ("preference_category", ["CONTRACT", "SCHEDULE", "TODO", "PAYSLIP"], "근로계약서 · 근무스케줄 · TO-DO · 급여명세서"),
    ("notification_template_histories", "channel"): ("notification_template_channel", ["NOTIFICATION", "PUSH", "EMAIL", "ALIMTALK"],
                                                     "운영 알림 · 앱 푸시 · 메일 · 알림톡"),
    ("notification_templates", "channel"): ("notification_template_channel", ["NOTIFICATION", "PUSH", "EMAIL", "ALIMTALK"],
                                            "운영 알림 · 앱 푸시 · 메일 · 알림톡"),
    ("posts", "content_type"): ("post_content_type", ["NOTICE", "FAQ"], "공지사항 · FAQ"),
    ("posts", "status"): ("post_status", ["DRAFT", "PUBLISHED", "PRIVATE"], "임시저장 · 게시 · 비공개"),
    ("posts", "notice_type"): ("notice_type", ["MAINTENANCE", "FEATURE", "TERMS", "GENERAL"], "점검 · 기능 · 약관 · 안내"),
    ("post_audiences", "audience_type"): ("post_audience_type", ["GUEST", "MEMBER", "BP", "STORE", "ADDON"],
                                          "비회원 · 회원 · BP · 점포 · 부가서비스"),
    ("inquiries", "status"): _INQ,
    ("leads", "interests"): ("lead_interest", ["STORE_OPERATION", "FINANCE", "FRANCHISE", "OTHER"],
                             "매장운영 · 재무관리 · 프랜차이즈 · 기타"),
    ("leads", "status"): _INQ,
}
ENUM_ARRAY = {("leads", "interests")}  # 여러 개 고르는 값 — enum 배열

# 타입·기본값 개별 지정
PHYS = {
    ("accounts", "failed_login_count"): {"default": "0"},
    ("password_reset_pins", "attempt_count"): {"default": "0"},
    ("contracts", "resend_count"): {"default": "0"},
    ("contracts", "status"): {"default": "'PENDING_SEND'"},
    ("staff_members", "employment_status"): {"default": "'EMPLOYED'"},
    ("staff_members", "join_status"): {"default": "'DRAFT'"},
    ("work_schedules", "break_minutes"): {"default": "0"},
    ("work_schedules", "confirm_status"): {"default": "'UNCONFIRMED'"},
    ("attendance_records", "entry_method"): {"default": "'SELF'"},
    ("todos", "status"): {"default": "'PENDING'"},
    ("payslips", "status"): {"default": "'DRAFTING'"},
    ("payslips", "is_premium_applied"): {"default": "true"},
    ("payslips", "gross_pay_amount"): {"default": "0"},
    ("payslips", "total_deduction_amount"): {"default": "0"},
    ("payslips", "net_pay_amount"): {"default": "0"},
    ("notification_preferences", "is_enabled"): {"default": "true"},
    ("posts", "status"): {"default": "'DRAFT'"},
    ("post_attachments", "sort_order"): {"default": "0"},
    ("inquiries", "status"): {"default": "'RECEIVED'"},
    ("leads", "status"): {"default": "'RECEIVED'"},
    **{(t, c): {"default": "CURRENT_TIMESTAMP"} for t, c in [
        ("identity_verifications", "verified_at"), ("auth_sessions", "issued_at"), ("auth_sessions", "last_used_at"),
        ("account_change_histories", "changed_at"), ("login_histories", "attempted_at"), ("password_reset_pins", "issued_at"),
        ("location_access_logs", "occurred_at"), ("staff_tax_profiles", "collected_at"), ("contract_status_histories", "changed_at"),
        ("work_schedule_histories", "changed_at"), ("attendance_records", "received_at"), ("attendance_corrections", "corrected_at"),
        ("todo_status_histories", "changed_at"), ("payslip_dispatches", "sent_at"), ("payslip_logs", "changed_at"),
        ("inquiry_replies", "replied_at"), ("location_consents", "agreed_at"),
        ("staff_member_retirement_logs", "processed_at"), ("alimtalk_send_logs", "sent_at")]},
    ("notification_templates", "is_active"): {"default": "true"},
    ("payslip_item_masters", "is_tax_free"): {"default": "false"},
    ("payslip_item_masters", "is_system_calculated"): {"default": "false"},
    ("payslip_item_masters", "is_active"): {"default": "true"},
}

# NOT NULL (PK·boolean·created_at·updated_at 은 자동). 나머지는 NULL 허용.
REQUIRED = {
    "identity_verifications": ["purpose", "phone", "result", "verified_at"],
    "auth_sessions": ["account_id", "refresh_token_hash", "issued_at", "last_used_at", "expires_at"],
    "accounts": ["email", "password_hash", "real_name", "birth_date", "phone", "status", "failed_login_count"],
    "account_change_histories": ["account_id", "field", "channel", "changed_at"],
    "login_histories": ["email", "attempted_at"],
    "password_reset_pins": ["account_id", "pin_hash", "issued_at", "expires_at", "attempt_count"],
    "location_access_logs": ["account_id", "action", "occurred_at", "method"],
    "staff_members": ["store_id", "name", "phone", "employment_type", "job_title", "employment_status", "join_status"],
    "staff_tax_profiles": ["rrn_encrypted", "bank_code", "payroll_account_number_encrypted", "purpose", "collected_at"],
    "invitations": ["staff_member_id", "invitation_type", "channel", "sent_at", "expires_at", "status"],
    "link_holds": ["invitation_id", "account_id", "mismatch_reason"],
    "contracts": ["staff_member_id", "store_id", "employment_type", "contract_method", "start_date", "work_terms",
                  "wage_terms", "status", "resend_count", "created_by"],
    "contract_documents": ["contract_id", "kind", "storage_key", "checksum"],
    "contract_status_histories": ["contract_id", "to_status", "actor", "changed_at"],
    "work_schedules": ["staff_member_id", "store_id", "start_at", "end_at", "break_minutes", "confirm_status", "created_by"],
    "work_schedule_histories": ["work_schedule_id", "change_type", "changed_by", "changed_at"],
    "location_consents": ["account_id", "consent_version", "agreed_at"],
    "attendance_records": ["staff_member_id", "store_id", "kind", "recorded_at", "received_at", "entry_method"],
    "attendance_corrections": ["attendance_record_id", "before_value", "after_value", "reason", "corrected_by", "corrected_at"],
    "todos": ["store_id", "title", "assignee_type", "execution_mode", "due_date", "status", "created_by"],
    "todo_status_histories": ["todo_id", "to_status", "changed_at"],
    "payslips": ["staff_member_id", "store_id", "contract_id", "period_start_date", "period_end_date", "employment_type",
                 "attendance_start_date", "attendance_end_date", "status", "gross_pay_amount", "total_deduction_amount",
                 "net_pay_amount"],
    "payslip_items": ["payslip_id", "item_category", "payslip_item_master_id", "item_name"],
    "payslip_item_masters": ["item_code", "name", "category", "is_tax_free", "is_system_calculated", "sort_order", "is_active"],
    "payslip_review_reasons": ["payslip_id", "review_reason"],
    "payslip_dispatches": ["payslip_id", "channel", "status", "sent_at"],
    "payslip_logs": ["payslip_id", "log_type", "summary", "changed_at"],
    "notifications": ["notification_target", "template_code", "body"],
    "notification_recipients": ["notification_id"],
    "notification_deliveries": ["notification_recipient_id", "channel"],
    "posts": ["content_type", "title", "body", "status"],
    "post_audiences": ["post_id", "audience_type"],
    "post_attachments": ["post_id", "file_name", "size_bytes", "storage_key", "sort_order"],
    "inquiries": ["created_by", "bp_code_id", "inquiry_category_code", "title", "body", "status"],
    "inquiry_replies": ["inquiry_id", "body", "replied_by", "replied_at"],
    "leads": ["contact_name", "industry_code", "phone", "email", "interests", "body", "privacy_agreed_at", "status"],
    "notification_templates": ["template_code", "template_name", "channel", "body", "variables", "is_active", "updated_at"],
    "notification_template_histories": ["notification_template_id", "template_code", "template_name", "channel", "body", "variables",
                                        "is_active", "changed_by", "changed_at"],
    "staff_member_retirement_logs": ["staff_member_id", "action", "retired_date", "processed_by", "processed_at"],
    "alimtalk_send_logs": ["template_code", "kakao_template_code", "to_phone", "body", "result", "reference_key", "sent_at"],
}

# 고유 제약: (테이블, 컬럼들, 조건 또는 None, 설명)
UNIQUES = [
    ("accounts", ["email"], None, "로그인 아이디 — 탈퇴 처리 방식이 정해지면 조건을 붙인다"),
    ("accounts", ["connecting_information"], None, "동일인 한 계정"),
    ("auth_sessions", ["refresh_token_hash"], None, "갱신 토큰 한 행"),
    ("invitations", ["invitation_token"], '"invitation_token" IS NOT NULL', "토큰은 가입 초대·재초대만"),
    ("location_consents", ["account_id"], '"withdrawn_at" IS NULL', "철회하지 않은 동의는 계정당 하나"),
    ("payslips", ["staff_member_id", "period_start_date", "period_end_date"], None, "같은 기간 중복 생성 차단"),
    ("payslip_items", ["payslip_id", "payslip_item_master_id"], None, "명세서 한 장에 같은 항목 한 줄"),
    ("payslip_item_masters", ["item_code"], None, "항목 코드 (2026-10-07 재영)"),
    ("payslip_review_reasons", ["payslip_id", "review_reason"], None, "명세서 한 장에 같은 사유 한 건"),
    ("notifications", ["dedupe_key"], '"dedupe_key" IS NOT NULL', "같은 사건·수신자 1회"),
    ("notification_templates", ["template_code"], None, "화면·로그·문의 대응에서 템플릿 하나를 가리키는 코드 (2026-10-07 재영)"),
]
# 고유 인덱스 이름이 63바이트를 넘을 때만 따로 정한다(넘으면 PostgreSQL 이 오류 없이 자른다). 기본은 {table}_{cols}_key.
KEY_NAMES = {}


def key_name(table, cols):
    return KEY_NAMES.get((table, tuple(cols)), f"{table}_{'_'.join(cols)}_key")


UNIQUES_NND = [
    ("post_audiences", ["post_id", "audience_type", "service_code"], 'true',
     "게시물마다 대상 한 번. 부가서비스가 아닌 대상(service_code NULL)끼리도 겹치지 않게 NULLS NOT DISTINCT"),
]

# CHECK 제약: (테이블, 이름 접미, 식)
CHECKS = [
    ("accounts", "email_lower", "\"email\" = lower(\"email\")"),
    ("accounts", "phone_format", "\"phone\" ~ '^[0-9]{10,11}$'"),
    ("accounts", "failed_login_count_nonnegative", "\"failed_login_count\" >= 0"),
    ("password_reset_pins", "attempt_count_range", "\"attempt_count\" BETWEEN 0 AND 5"),
    ("location_access_logs", "provide_fields", "\"action\" <> 'PROVIDE' OR (\"recipient\" IS NOT NULL AND \"purpose\" IS NOT NULL)"),
    ("staff_members", "phone_format", "\"phone\" ~ '^[0-9]{10,11}$'"),
    ("staff_members", "retired_date_required", "\"employment_status\" <> 'RETIRED' OR \"retired_date\" IS NOT NULL"),
    ("invitations", "token_required", "\"invitation_type\" NOT IN ('SIGNUP', 'REINVITE') OR \"invitation_token\" IS NOT NULL"),
    ("contracts", "end_date_after_start", "\"end_date\" IS NULL OR \"end_date\" >= \"start_date\""),
    ("contracts", "resend_count_nonnegative", "\"resend_count\" >= 0"),
    ("work_schedules", "end_after_start", "\"end_at\" > \"start_at\""),
    ("work_schedules", "break_minutes_nonnegative", "\"break_minutes\" >= 0"),
    ("attendance_records", "proxy_fields", "\"entry_method\" <> 'PROXY' OR (\"proxy_by\" IS NOT NULL AND \"proxy_reason\" IS NOT NULL)"),
    ("todo_status_histories", "single_actor", "num_nonnulls(\"changed_by\", \"staff_member_id\") <= 1"),
    ("payslips", "period_end_after_start", "\"period_end_date\" >= \"period_start_date\""),
    ("payslips", "attendance_end_after_start", "\"attendance_end_date\" >= \"attendance_start_date\""),
    ("payslips", "net_pay_amount_balance", "\"net_pay_amount\" = \"gross_pay_amount\" - \"total_deduction_amount\""),
    ("notification_recipients", "single_recipient", "num_nonnulls(\"account_id\", \"admin_account_id\") = 1"),
    ("post_audiences", "service_code_required", "(\"audience_type\" = 'ADDON') = (\"service_code\" IS NOT NULL)"),
    ("payslip_item_masters", "item_code_format", "\"item_code\" ~ '^[A-Z][A-Z0-9_]*$'"),
    ("post_attachments", "size_bytes_range", "\"size_bytes\" BETWEEN 1 AND 10485760"),
    # 수신 설정 묶음은 앱 푸시 템플릿만, 그리고 앱 푸시면 반드시 (직원이 끌 수 있는 단위가 정해져 있어야 한다)
    ("notification_templates", "preference_category_push_only", "(\"channel\" = 'PUSH') = (\"preference_category\" IS NOT NULL)"),
    # 근로계약서 · 급여명세서 알림은 끌 수 없다 (운영 정책 NTF-14)
    ("notification_preferences", "mandatory_enabled", "\"preference_category\" NOT IN ('CONTRACT', 'PAYSLIP') OR \"is_enabled\""),
    ("notification_templates", "alimtalk_fields",
     "(\"channel\" = 'ALIMTALK') = (\"kakao_template_code\" IS NOT NULL)"),
    # 제목은 운영 알림·앱 푸시·메일에 필수, 알림톡은 쓰지 않는다 (2026-10-07 재영)
    # 템플릿 코드는 등록 때 「채널 접두 + 유형·용도」로 채워 주지만 운영자가 바꿀 수 있다 (2026-10-07 재영) — 형식만 건다
    ("notification_templates", "template_code_format", "\"template_code\" ~ '^[A-Z][A-Z0-9_]*$'"),
    # 변수 목록은 [{name, label, isRequired, sampleValue}] 배열. 원소 모양 · 이름 규칙(#·중괄호·공백 금지) ·
    # 「본문의 #{변수} ⊆ 목록」은 저장 때 앱이 검사한다. DB 는 배열인지만 본다.
    # 퇴직 처리 이력: 앞당긴 계약과 원래 종료일은 처리(RETIRE) 행에만, 원래 종료일은 계약이 있을 때만
    ("staff_member_retirement_logs", "contract_only_on_retire",
     "\"action\" = 'RETIRE' OR (\"contract_id\" IS NULL AND \"previous_contract_end_date\" IS NULL)"),
    ("staff_member_retirement_logs", "end_date_needs_contract", "\"previous_contract_end_date\" IS NULL OR \"contract_id\" IS NOT NULL"),
    ("notification_templates", "variables_array", "jsonb_typeof(\"variables\") = 'array'"),
    ("notification_template_histories", "variables_array", "jsonb_typeof(\"variables\") = 'array'"),
    ("notification_templates", "title_by_channel", "(\"channel\" = 'ALIMTALK') = (\"title\" IS NULL)"),
    # 알림톡 발송 이력: 숫자만 남긴 휴대폰 번호, 관련 업무는 유형과 ID 를 함께만
    ("alimtalk_send_logs", "to_phone_format", "\"to_phone\" ~ '^01[0-9]{8,9}$'"),
    ("alimtalk_send_logs", "related_pair", "num_nonnulls(\"related_type\", \"related_id\") <> 1"),
    ("posts", "publish_end_after_start", "\"publish_end_date\" IS NULL OR \"publish_end_date\" >= \"publish_start_date\""),
]

# 겹침 금지 (btree_gist 필요)
EXCLUDES = [
    ("work_schedules", "no_overlap",
     "USING gist (\"staff_member_id\" WITH =, tstzrange(\"start_at\", \"end_at\") WITH &&) WHERE (NOT \"is_deleted\")",
     "같은 직원의 근무스케줄은 겹치지 않는다"),
]

# 조회용 인덱스. 고유 제약이 앞머리를 덮으면 두지 않는다.
INDEXES = [
    ("identity_verifications", ["account_id"]), ("auth_sessions", ["account_id"]),
    ("account_change_histories", ["account_id", "changed_at"]), ("login_histories", ["account_id", "attempted_at"]),
    ("password_reset_pins", ["account_id"]), ("location_access_logs", ["account_id", "occurred_at"]),
    ("staff_members", ["store_id"]), ("staff_members", ["account_id"]),
    ("invitations", ["staff_member_id"]), ("link_holds", ["invitation_id"]),
    ("contracts", ["staff_member_id"]), ("contracts", ["store_id", "status"]),
    ("contract_documents", ["contract_id"]), ("contract_status_histories", ["contract_id", "changed_at"]),
    ("work_schedules", ["store_id", "start_at"]), ("work_schedule_histories", ["work_schedule_id", "changed_at"]),
    ("attendance_records", ["staff_member_id", "recorded_at"]), ("attendance_records", ["store_id", "recorded_at"]),
    ("attendance_corrections", ["attendance_record_id"]),
    ("todos", ["store_id", "due_date"]), ("todo_assignees", ["staff_member_id"]),
    ("todo_status_histories", ["todo_id", "changed_at"]),
    ("payslips", ["store_id", "period_start_date"]), ("payslip_dispatches", ["payslip_id"]),
    ("payslip_logs", ["payslip_id", "changed_at"]),
    ("notification_recipients", ["account_id"]), ("notification_recipients", ["admin_account_id"]),
    ("notification_recipients", ["notification_id"]), ("notification_deliveries", ["notification_recipient_id"]),
    # changed_at 까지 넣으면 이름이 71바이트로 63바이트 한도를 넘는다. 템플릿 하나의 이력은 많지 않아 앞 열로 충분하다.
    ("notification_template_histories", ["notification_template_id"]),
    ("staff_member_retirement_logs", ["staff_member_id", "processed_at"]),
    ("alimtalk_send_logs", ["related_type", "related_id"]), ("alimtalk_send_logs", ["to_phone", "sent_at"]),
    ("post_attachments", ["post_id"]), ("inquiries", ["bp_code_id"]), ("inquiry_replies", ["inquiry_id"]),
]

# 지우지 않는 기록 — is_deleted 를 두면 안 되는 테이블 (네이밍 규칙 삭제 표시)
HISTORY_LIKE = ("_histories", "_logs")
