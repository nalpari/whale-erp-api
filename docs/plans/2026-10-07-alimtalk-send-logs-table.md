# 알림톡 발송 이력 테이블 제안 (front 논리 ERD 반영 요청)

- 요청: 2026-10-07, api `snorlax` (PR #6)
- 상태: 반영됨 2026-10-08 — front PR #2(논리 · 물리), api 마이그레이션 `20261008000100_team3_alimtalk_send_logs`
- 근거: 메일은 `mail_send_logs` 가 있지만 알림톡은 발송 기록이 앱 로그 한 줄뿐이다. 기존
  `notification_deliveries` 는 `notification_recipients` 행에 묶여 있어 가입 초대처럼 계정이 없는
  사람에게 보내는 알림톡을 담지 못한다.
- api 쪽 설계: `docs/plans/2026-10-07-alimtalk-db-templates-design.md` 2단계

### 알림톡 발송 이력 `alimtalk_send_logs` · 이력

| 키 | 속성 | 논리 타입 | 제안 컬럼 | 비고 |
|---|---|---|---|---|
| PK | 알림톡 발송 이력 ID | id | `alimtalk_send_log_id` |  |
|  | 템플릿 코드 | text | `template_code` | 보낸 알림 템플릿 |
|  | 카카오 템플릿 코드 | text | `kakao_template_code` | 보낸 시점 값 — 템플릿 행은 고쳐질 수 있다 |
|  | 수신 번호 | text | `to_phone` | 숫자만, 01X 휴대폰 |
|  | 관련 업무 유형 | text | `related_type` | 선택 — 예 INVITATION |
|  | 관련 업무 ID | id | `related_id` | 선택 — 유형과 함께만 |
|  | 보낸 본문 | text | `body` | 호출부가 지정한 값은 ******** |
|  | 발송 결과 | enum | `result` | 성공·실패 (비즈뿌리오 접수 기준) |
|  | 실패 사유 | text | `failure_reason` | 비즈뿌리오 코드 · HTTP 상태 · 메시지 |
|  | 요청 키 | text | `reference_key` | 결과 리포트의 REFKEY |
|  | 메시지 키 | text | `message_key` | 비즈뿌리오가 붙인 키 |
| FK | 발송 관리자 | id | `sent_by` | 관리자가 대신 보냈을 때 |
|  | 발송 일시 | datetime | `sent_at` |  |

**관계**

- 관리자 계정 `1` — `N` 알림톡 발송 이력 · 발송

**물리 쪽에서 더할 것 (api `_model.py`)**

- `result` 는 기존 enum `dispatch_result`(SUCCEEDED · FAILED)
- CHECK `alimtalk_send_logs_to_phone_format`: `"to_phone" ~ '^01[0-9]{8,9}$'`
- CHECK `alimtalk_send_logs_related_pair`: `num_nonnulls("related_type", "related_id") <> 1`
- INDEX (`related_type`, `related_id`), INDEX (`to_phone`, `sent_at`)
- `is_deleted` 없음 — `_logs` 는 지우지 않는다
