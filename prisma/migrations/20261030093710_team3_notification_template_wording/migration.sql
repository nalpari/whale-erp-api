-- 알림 템플릿 기본 문구 42건 정리 (2026-10-29 노영주, 「알림톡_템플릿_20261029.xlsx」 — 카카오 심사 전 문구 다듬기 포함).
--
-- 엑셀의 title · body · default_variables 가 이 마이그레이션 직전의 기본 문구(default_*)와 같은 42건을 edit_* 의 새 문구로 바꾼다.
-- 엑셀에 없는 기본 템플릿 4건(EMAIL_EXCEL_READY · EMAIL_EXCEL_FAILED · EMAIL_STAFF_AFFILIATION_REQUEST · TALK_STAFF_AFFILIATION_REQUEST)은
-- 건드리지 않는다. 변수 목록은 거절 사유를 선택 변수로 더하는 NTF_AFFILIATION_REJECTED · EMAIL_AFFILIATION_REJECTED 두 건만 바뀌고,
-- 나머지는 그대로다. 알림톡 TALK_STAFF_INVITATION 의 제목은 null 그대로다(알림톡은 제목을 쓰지 않는다).
-- 예외: PUSH_PAYSLIP_RESENT · EMAIL_PAYSLIP_RESENT 는 엑셀의 재발송 문구 대신 PUSH_PAYSLIP_SENT · EMAIL_PAYSLIP_SENT 의 새 문구(제목 · 본문)를
-- 그대로 따른다 — 급여명세서는 다시 보내도 처음 발송과 같은 문구다(20261021100935 · 운영 정책 NTF-20 유지, 2026-10-29 노영주).
-- 템플릿 코드 · 이름 · 채널 · 수신 설정 묶음 · 사용 여부 · 카카오 템플릿 코드는 그대로다.
--
-- 되돌리기 원본(default_title · default_body · default_variables)은 42건 모두 새 값으로 바꾼다.
-- 운영자가 이미 고친 문구는 덮어쓰지 않는다 — 제목 · 본문 · 변수 목록이 셋 다 옛 기본값 그대로일 때만 지금 값(title · body · variables)을
-- 새 값으로 바꾼다. 하나만 바꾸면 본문의 변수와 변수 목록이 어긋날 수 있어 셋을 같이 본다. 그래서 지금 값을 먼저 바꾸고(옛 기본값과 비교),
-- 그 다음에 되돌리기 원본을 바꾼다. 변경 이력은 남기지 않는다(20261021100935 와 같다).
-- 문자열은 달러 인용($t$ … $t$)이라 줄바꿈 · 따옴표가 엑셀 셀 그대로다.

CREATE TEMP TABLE "_notification_template_wording" (
  "template_code" text PRIMARY KEY,
  "title" text,
  "body" text NOT NULL,
  "variables" jsonb -- null 이면 변수 목록은 그대로
);

INSERT INTO "_notification_template_wording" ("template_code", "title", "body", "variables") VALUES
    ('NTF_LEAD_RECEIVED', $t$신규 도입문의 접수$t$, $t$신규 도입문의가 접수되었습니다.

- 문의자: #{도입문의자}$t$, NULL),
    ('EMAIL_LEAD_CONFIRMATION', $t$[WHALE ERP] 도입문의 접수 완료$t$, $t$안녕하세요.
WHALE ERP 도입문의가 정상적으로 접수되었습니다.

담당자가 문의 내용을 확인한 뒤,
영업일 기준 1~2일 안에 연락드리겠습니다.

감사합니다.$t$, NULL),
    ('NTF_INQUIRY_RECEIVED', $t$신규 문의사항 접수$t$, $t$신규 문의사항이 등록되었습니다.

- 문의자: #{문의자}
- 제목: #{문의제목}$t$, NULL),
    ('NTF_INQUIRY_ANSWERED', $t$문의 답변 등록$t$, $t$문의하신 내용에 답변이 등록되었습니다.

- 제목: #{문의제목}$t$, NULL),
    ('NTF_LEAD_ANSWERED', $t$도입문의 상태 변경$t$, $t$도입문의 처리 상태가 변경되었습니다.

- 문의자: #{도입문의자}
- 변경 상태: #{처리상태}$t$, NULL),
    ('NTF_CONTRACT_SIGNED', $t$근로계약 체결 완료$t$, $t$#{직원이름} 님이 근로계약서에 서명했습니다.
근로계약 체결이 완료되었습니다.

- 근무지: #{근무지}

직원이 직원 근무 앱에서 신고 정보를 입력해야 합니다.
입력을 마쳤는지 확인해 주세요.$t$, NULL),
    ('NTF_CONTRACT_REJECTED', $t$근로계약서 서명 거부$t$, $t$#{직원이름} 님이 근로계약서 서명을 거부했습니다.

- 거부 사유: #{거부사유}

필요하면 계약 조건을 수정해
근로계약서를 다시 보내 주세요.$t$, NULL),
    ('NTF_CONTRACT_EXPIRED', $t$근로계약서 서명 기한 만료$t$, $t$#{직원이름} 님의 근로계약서 서명 기한이 지나 계약서가 만료되었습니다.

- 근무지: #{근무지}

필요하면 근로계약서를 다시 보내 주세요.$t$, NULL),
    ('NTF_AFFILIATION_REJECTED', $t$소속 추가 거절$t$, $t$#{직원이름} 님이 소속 추가 요청을 거절했습니다.

- 근무지: #{근무지}
- 거절 사유: #{거절사유}

필요하면 소속 추가를 다시 요청해 주세요.$t$, '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "거절사유", "label": "거절 사유", "isRequired": false, "sampleValue": "다른 매장 소속이 아닙니다"}]'::jsonb),
    ('EMAIL_LEAD_REPLY', $t$[WHALE ERP] 도입문의 답변 안내$t$, $t$안녕하세요.
WHALE ERP 도입문의에 답변드립니다.

#{답변}

감사합니다.$t$, NULL),
    ('NTF_LINK_HOLD', $t$직원 가입 연결 보류$t$, $t$#{직원이름} 님의 가입 연결이 보류되었습니다.

- 보류 사유: #{보류사유}

보류 사유를 확인한 뒤
직원 연결을 완료해 주세요.$t$, NULL),
    ('NTF_CONTRACT_RENEWAL_DUE', $t$근로계약 종료 예정$t$, $t$#{직원이름} 님의 근로계약이 곧 종료됩니다.

- 근무지: #{근무지}
- 종료일: #{계약종료일}

계약을 갱신하려면
종료일 전에 근로계약서를 다시 보내 주세요.$t$, NULL),
    ('PUSH_CONTRACT_SENT', $t$근로계약서 서명 요청$t$, $t$#{근무지}에서 근로계약서를 보냈습니다.

- 서명 기한: #{날인기한}

계약 내용을 확인하고 서명해 주세요.$t$, NULL),
    ('PUSH_PAYSLIP_SENT', $t$#{급여월} 급여명세서 안내$t$, $t$#{근무지}에서 #{급여월} 급여명세서를 보냈습니다.
직원 근무 앱에서 확인해 주세요.$t$, NULL),
    ('EMAIL_INQUIRY_RECEIVED', $t$[WHALE ERP] 신규 문의사항 접수$t$, $t$#{문의자}에서 문의사항을 등록했습니다.

- 제목: #{문의제목}

관리자 웹 [커뮤니티 관리]에서 답변해 주세요.$t$, NULL),
    ('EMAIL_LEAD_RECEIVED', $t$[WHALE ERP] 신규 도입문의 접수$t$, $t$신규 도입문의가 접수되었습니다.

- 문의자: #{도입문의자}

관리자 웹에서 문의 내용을 확인해 주세요.$t$, NULL),
    ('EMAIL_INQUIRY_ANSWERED', $t$[WHALE ERP] 문의 답변 등록$t$, $t$문의하신 내용에 답변이 등록되었습니다.

- 제목: #{문의제목}

[고객지원 › 문의사항]에서 답변을 확인해 주세요.$t$, NULL),
    ('EMAIL_SIGNUP_ALERT', $t$[WHALE ERP] 신규 BP 가입$t$, $t$신규 BP가 WHALE ERP에 가입했습니다.

- BP: #{BP이름}

사업자 정보를 확인해 주세요.$t$, NULL),
    ('EMAIL_LEAD_ANSWERED', $t$[WHALE ERP] 도입문의 상태 변경$t$, $t$도입문의 처리 상태가 변경되었습니다.

- 문의자: #{도입문의자}
- 변경 상태: #{처리상태}$t$, NULL),
    ('EMAIL_CONTRACT_SIGNED', $t$[WHALE ERP] 근로계약 체결 완료$t$, $t$#{직원이름} 님이 근로계약서에 서명했습니다.
근로계약 체결이 완료되었습니다.

- 근무지: #{근무지}

직원이 직원 근무 앱에서 신고 정보를 입력해야 합니다.
입력을 마쳤는지 확인해 주세요.$t$, NULL),
    ('EMAIL_CONTRACT_REJECTED', $t$[WHALE ERP] 근로계약서 서명 거부$t$, $t$#{직원이름} 님이 근로계약서 서명을 거부했습니다.

- 근무지: #{근무지}
- 거부 사유: #{거부사유}

필요하면 계약 조건을 수정해
근로계약서를 다시 보내 주세요.$t$, NULL),
    ('EMAIL_CONTRACT_EXPIRED', $t$[WHALE ERP] 근로계약서 서명 기한 만료$t$, $t$#{직원이름} 님의 근로계약서 서명 기한이 지나 계약서가 만료되었습니다.

- 근무지: #{근무지}

필요하면 근로계약서를 다시 보내 주세요.$t$, NULL),
    ('EMAIL_AFFILIATION_REJECTED', $t$[WHALE ERP] 소속 추가 거절$t$, $t$#{직원이름} 님이 소속 추가 요청을 거절했습니다.

- 근무지: #{근무지}
- 거절 사유: #{거절사유}

필요하면 소속 추가를 다시 요청해 주세요.$t$, '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}, {"name": "거절사유", "label": "거절 사유", "isRequired": false, "sampleValue": "다른 매장 소속이 아닙니다"}]'::jsonb),
    ('EMAIL_CONTRACT_RENEWAL_DUE', $t$[WHALE ERP] 근로계약 종료 예정$t$, $t$#{직원이름} 님의 근로계약이 곧 종료됩니다.

- 근무지: #{근무지}
- 종료일: #{계약종료일}

계약을 갱신하려면
종료일 전에 근로계약서를 다시 보내 주세요.$t$, NULL),
    ('EMAIL_STAFF_RESET_LINK', $t$[WHALE ERP] 비밀번호 재설정 안내$t$, $t$#{근무지} 관리자가 비밀번호 초기화를 요청했습니다.

아래 버튼을 눌러 새 비밀번호를 설정해 주세요.

※ 링크는 24시간 동안 1회만 사용할 수 있습니다.$t$, NULL),
    ('EMAIL_CHANGE_PIN', $t$[WHALE ERP] 로그인 이메일 변경 인증$t$, $t$로그인 이메일을 바꾸려면 아래 핀을 직원 근무 앱에 입력해 주세요.

- 인증 핀: #{핀}

※ 핀은 15분 동안 유효합니다.
※ 직접 요청하지 않았다면 이 메시지를 무시해 주세요.$t$, NULL),
    ('EMAIL_STAFF_PASSWORD_PIN', $t$[WHALE ERP] 비밀번호 재설정 인증$t$, $t$비밀번호를 다시 설정하려면 아래 핀을 직원 근무 앱에 입력해 주세요.

- 인증 핀: #{핀}

※ 핀은 10분 동안 유효합니다.
※ 직접 요청하지 않았다면 이 메시지를 무시해 주세요.$t$, NULL),
    ('EMAIL_SIGNUP_DONE', $t$[WHALE ERP] 회원가입 완료$t$, $t$#{관리자이름} 님, WHALE ERP에 오신 것을 환영합니다.
#{BP이름}의 회원가입이 완료되었습니다.

- 로그인 아이디: #{로그인아이디}

관리자 웹에서 매장 관리부터 시작해 보세요.
이후 아래 업무를 이용할 수 있습니다.
· 직원 초대와 근로계약서 발송
· 급여명세서 발송
· 근무스케줄 관리

사용 중 궁금한 점은 관리자 웹 [고객지원 › 문의사항]으로 남겨 주세요.

감사합니다.$t$, NULL),
    ('EMAIL_BP_REGISTER', $t$[WHALE ERP] BP 계정 등록 안내$t$, $t$#{관리자이름} 님, 플랫폼 운영자가 #{BP이름} 계정을 WHALE ERP에 등록했습니다.

- 로그인 아이디: #{로그인아이디}
- 임시 비밀번호: #{임시비밀번호}

※ 처음 로그인할 때 비밀번호를 변경해 주세요.$t$, NULL),
    ('EMAIL_PLAT_ADMIN_CREATE', $t$[WHALE ERP] 플랫폼 관리자 계정 생성$t$, $t$#{관리자이름} 님의 WHALE ERP 플랫폼 관리자 계정이 만들어졌습니다.

- 로그인 아이디: #{로그인아이디}
- 임시 비밀번호: #{임시비밀번호}

※ 처음 로그인할 때 비밀번호를 변경해 주세요.$t$, NULL),
    ('EMAIL_BP_ADMIN_CREATE', $t$[WHALE ERP] 관리자 계정 생성$t$, $t$#{관리자이름} 님의 #{BP이름} 관리자 계정이 만들어졌습니다.

- 로그인 아이디: #{로그인아이디}
- 임시 비밀번호: #{임시비밀번호}

※ 처음 로그인할 때 비밀번호를 변경해 주세요.$t$, NULL),
    ('EMAIL_PASSWORD_RESET', $t$[WHALE ERP] 비밀번호 초기화 안내$t$, $t$#{관리자이름} 님의 비밀번호가 초기화되었습니다.

- 임시 비밀번호: #{임시비밀번호}

※ 임시 비밀번호는 1시간 동안 유효합니다.
※ 로그인한 뒤 새 비밀번호를 설정해 주세요.$t$, NULL),
    ('PUSH_TODO_DUE_SOON', $t$TO-DO 수행 예정 알림$t$, $t$예정된 TO-DO 시간이 다가오고 있습니다.

- TO-DO: #{TO-DO제목}
- 예정 일시: #{수행예정일시}$t$, NULL),
    ('EMAIL_TEMP_PASSWORD', $t$[WHALE ERP] 임시 비밀번호 발급$t$, $t$#{관리자이름} 님이 요청하신 임시 비밀번호입니다.

- 임시 비밀번호: #{임시비밀번호}

※ 1시간 동안 사용할 수 있습니다.
※ 직접 요청하지 않았다면 바로 관리자에게 알려 주세요.$t$, NULL),
    ('EMAIL_WITHDRAW_DONE', $t$[WHALE ERP] 회원 탈퇴 완료$t$, $t$#{BP이름}의 WHALE ERP 회원 탈퇴가 완료되었습니다.

- 탈퇴일: #{탈퇴일}

그동안 WHALE ERP를 이용해 주셔서 감사합니다.$t$, NULL),
    ('EMAIL_PAYSLIP_SENT', $t$[WHALE ERP] #{급여월} 급여명세서 안내$t$, $t$#{직원이름} 님, #{근무지}에서 #{급여월} 급여명세서를 보냈습니다.

직원 근무 앱 [급여] 탭에서 확인해 주세요.$t$, NULL),
    ('PUSH_SCHEDULE_CHANGED', $t$근무스케줄 변경$t$, $t$#{근무지} 근무스케줄이 변경되었습니다.

- 변경 내용: #{변경내용}

직원 근무 앱에서 바뀐 스케줄을 확인해 주세요.$t$, NULL),
    ('EMAIL_LINK_HOLD', $t$[WHALE ERP] 직원 가입 연결 보류$t$, $t$#{직원이름} 님이 가입했지만, 본인인증 정보가 등록된 정보와 달라 연결이 보류되었습니다.

- 보류 사유: #{보류사유}

직원에게 연락해 휴대전화번호를 확인한 뒤 연결하거나, 번호를 수정해 다시 초대해 주세요.$t$, NULL),
    ('PUSH_PAYSLIP_RESENT', $t$#{급여월} 급여명세서 안내$t$, $t$#{근무지}에서 #{급여월} 급여명세서를 보냈습니다.
직원 근무 앱에서 확인해 주세요.$t$, NULL),
    ('EMAIL_PAYSLIP_RESENT', $t$[WHALE ERP] #{급여월} 급여명세서 안내$t$, $t$#{직원이름} 님, #{근무지}에서 #{급여월} 급여명세서를 보냈습니다.

직원 근무 앱 [급여] 탭에서 확인해 주세요.$t$, NULL),
    ('NTF_SIGNUP_UNDER_AGE', $t$직원 가입 불가 (만 19세 미만)$t$, $t$#{직원이름} 님은 만 19세 미만이라 가입할 수 없습니다.

- 근무지: #{근무지}

생년월일과 근로계약서를 확인해 주세요.$t$, NULL),
    ('TALK_STAFF_INVITATION', NULL, $t$[WHALE ERP] 직원 근무 앱 가입 초대

#{근무지}에서 WHALE ERP 직원 근무 앱으로 초대했습니다.
아래 버튼을 눌러 가입한 뒤 근로계약서를 확인해 주세요.

- 초대 코드: #{초대코드}

※ 앱에서 직접 가입할 때는 휴대전화번호와 초대 코드를 입력해 주세요.
※ 초대 코드와 링크는 30일 동안 유효합니다.$t$, NULL);

-- 바꿀 42건이 모두 있어야 한다 (코드 하나라도 없으면 멈춘다).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r
    JOIN "_notification_template_wording" AS w ON w."template_code" = r."template_code";
  IF n <> 42 THEN
    RAISE EXCEPTION '문구를 바꿀 알림 템플릿 42건이 모두 있지 않다: %', n;
  END IF;
END $$;

-- 1) 지금 값: 셋 다 옛 기본값 그대로일 때만. default_* 를 바꾸기 전에 비교한다.
UPDATE "notification_templates" AS r
   SET "title" = w."title", "body" = w."body", "variables" = COALESCE(w."variables", r."default_variables"),
       "updated_at" = now()
  FROM "_notification_template_wording" AS w
 WHERE r."template_code" = w."template_code"
   AND r."title" IS NOT DISTINCT FROM r."default_title" AND r."body" = r."default_body"
   AND r."variables" = r."default_variables";

-- 2) 되돌리기 원본: 42건 모두.
UPDATE "notification_templates" AS r
   SET "default_title" = w."title", "default_body" = w."body",
       "default_variables" = COALESCE(w."variables", r."default_variables"), "updated_at" = now()
  FROM "_notification_template_wording" AS w
 WHERE r."template_code" = w."template_code";

-- 검증은 되돌리기 원본만 본다 — 제목 · 본문 · 변수는 운영자가 고쳤을 수 있다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM "notification_templates" AS r
    JOIN "_notification_template_wording" AS w ON w."template_code" = r."template_code"
   WHERE r."default_title" IS NOT DISTINCT FROM w."title" AND r."default_body" = w."body"
     AND (w."variables" IS NULL OR r."default_variables" = w."variables");
  IF n <> 42 THEN
    RAISE EXCEPTION '알림 템플릿 기본 문구 42건이 새 문구와 같아지지 않았다: %', n;
  END IF;
END $$;

DROP TABLE "_notification_template_wording";
