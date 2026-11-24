-- 소속 추가 확인 요청 알림톡 · 메일을 카카오(비즈뿌리오) 재등록본에 맞춘다(WHALEERP-745 첫 줄 · WHALEERP-738 버튼).
--
-- 카카오 템플릿 코드 TALK_STAFF_AFFILIATION_V2(카카오 쪽 템플릿 이름 「소속 추가 요청」)는 2026-11-24 김민식 등록 · 같은 날 승인됐다(등록 화면의
-- 본문 · 버튼 「요청 확인하기」 https://#{링크} 를 아래 본문과 대조했다).
--
-- 카카오 등록본은 승인 뒤 고칠 수 없어 새 카카오 템플릿 코드로 다시 등록했다. 우리 템플릿 코드 TALK_STAFF_AFFILIATION_REQUEST 는
-- 그대로 두고 kakao_template_code 만 바꾼다(전례: TALK_STAFF_CONTRACT_SENT 의 카카오 코드 PUSH_CONTRACT_SENT).
-- 1) 알림톡 TALK_STAFF_AFFILIATION_REQUEST
--    - 첫 줄에서 #{사업자} 를 뺀다 — 점포 이름이 상호로 시작하면 「도레미커피 도레미커피 신촌점에서」처럼 겹쳤다(WHALEERP-745). 직원
--      쪽 소속 표시는 점포 이름만 쓴다(WHALEERP-747). 본사 근무지도 점포 이름 그대로다(「[본사]」를 붙이지 않는다, 2026-11-20 결정).
--    - [요청 확인하기] 웹링크 버튼을 단다(WHALEERP-738) — 링크 변수 「링크」(버튼 링크, 직원 앱 요청 화면 /affiliations). 버튼 이름은
--      코드(src/alimtalk/alimtalk-buttons.ts)가 싣는다.
--    - 본문 · 되돌리기 원본(default_body)을 재등록본으로, 변수 목록 · 되돌리기 원본을 근무지 · 고용형태 · 링크로 맞춘다. 링크 항목은
--      20261027154954 원본 그대로다(20261103175100 이 뺐던 것). 운영자가 고친 문구도 덮어쓴다(20261103175100 과 같다) — 등록본과 다른
--      문구는 카카오가 거절해 대체 문자로만 간다. 제목(null) · 이름 · 사용 여부는 그대로다.
-- 2) 메일 EMAIL_STAFF_AFFILIATION_REQUEST — 본문 첫 줄 「#{사업자} #{근무지}에서」 → 「#{근무지}에서」, 변수에서 사업자를 뺀다.
--    제목은 이미 「[WHALE ERP] #{근무지}에서 …」다. 새 코드는 사업자를 넘기지 않아, 지금 값에 사업자가 남으면 필수 변수가 비어
--    메일이 로그만 남기고 나가지 않는다(PR #323 code-review). 그래서 운영자가 고친 메일도 지금 값의 첫 줄 「#{사업자} 」는 늘
--    걷어내고(나머지 문구는 둔다), 변수 사업자는 제목 · 본문에 #{사업자} 가 더 없을 때 뺀다. 그래도 남으면(운영자가 다른 곳에
--    #{사업자} 를 씀) 배포를 멈춘다 — 그 문구를 기본으로 되돌리거나 고친 뒤 다시 배포한다. 되돌리기 원본은 늘 바꾼다(updated_at 은
--    올리지 않는다, 20261109165622 와 같다). 2026-11-24 개발 DB 는 지금 값이 원본 그대로였다.
--
-- 배포: 코드와 함께 나가야 한다. 이 파일만 적용되면 옛 코드가 버튼 이름이 없다고(NO_BUTTON_NAME), 코드만 나가면 버튼 링크 변수가
-- 없다고(LINK_MISMATCH) 소속 추가 확인 요청을 막는다 — 머지 직후 deploy 와 api 배포를 함께 한다.
--
-- 변경 이력은 남기지 않는다. 문자열은 달러 인용($t$ … $t$)이라 줄바꿈이 등록본 그대로다. 저장소에 .gitattributes 가 없어
-- Windows 체크아웃(autocrlf)은 이 파일을 CRLF 로 바꾸므로 \r 을 지워 넣고, 등록본 전체가 같은지 · \r 이 없는지 검증한다.
-- 채널이 알림톡이 아닌 행(운영자가 바꿈)은 카카오 코드를 넣으면 CHECK 에 걸리므로 바꾸지 않고 검증에서 멈춘다.

-- 1) 알림톡 ---------------------------------------------------------------------------------------------------------------------

CREATE TEMP TABLE "_staff_affiliation_reregistered" AS
SELECT replace($t$#{근무지}에서 소속 추가를 요청했습니다.
고용 형태: #{고용형태}
WHALE ERP 직원 근무 앱에 로그인해 요청을 확인하고 수락하면 근로계약서를 받을 수 있습니다.
요청은 30일 동안 유효합니다.$t$, E'\r', '') AS "body",
       '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "고용형태", "label": "고용 형태", "isRequired": true, "sampleValue": "파트타이머"}, {"name": "링크", "label": "직원 앱 요청 화면(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…/affiliations", "isButtonLink": true}]'::jsonb AS "variables";

UPDATE "notification_templates" AS r
   SET "body" = t."body", "default_body" = t."body", "variables" = t."variables", "default_variables" = t."variables",
       "kakao_template_code" = 'TALK_STAFF_AFFILIATION_V2',
       "updated_at" = now()
  FROM "_staff_affiliation_reregistered" AS t
 WHERE r."template_code" = 'TALK_STAFF_AFFILIATION_REQUEST' AND r."channel" = 'ALIMTALK';

-- 본문은 등록본 전체(\r 없이, 네 줄), 변수는 근무지 · 고용형태와 버튼 링크 변수 링크(하나에만 표시) 셋이고 사업자는 없어야 발송 ·
-- 저장 검사를 지난다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r, "_staff_affiliation_reregistered" AS t
   WHERE r."template_code" = 'TALK_STAFF_AFFILIATION_REQUEST'
     AND r."channel" = 'ALIMTALK'
     AND r."kakao_template_code" = 'TALK_STAFF_AFFILIATION_V2'
     AND r."body" = t."body" AND r."default_body" = t."body"
     AND position(E'\r' IN r."body") = 0
     AND array_length(string_to_array(r."body", E'\n'), 1) = 4
     AND r."variables" = r."default_variables"
     AND jsonb_array_length(r."variables") = 3
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "근무지")')
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "고용형태")')
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "링크" && @.isButtonLink == true)')
     AND NOT jsonb_path_exists(r."variables", '$[*] ? (@.name != "링크" && @.isButtonLink == true)')
     AND NOT jsonb_path_exists(r."variables", '$[*] ? (@.name == "사업자")');
  IF n <> 1 THEN
    RAISE EXCEPTION '소속 추가 확인 요청 알림톡 템플릿이 카카오 재등록본과 같아지지 않았다: %', n;
  END IF;
END $$;

DROP TABLE "_staff_affiliation_reregistered";

-- 2) 메일 -----------------------------------------------------------------------------------------------------------------------

-- 되돌리기 원본이 이 파일이 아는 옛 첫 줄 · 변수 그대로인지 먼저 본다 — 아니면 replace 가 아무것도 바꾸지 않고 지나간다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'EMAIL_STAFF_AFFILIATION_REQUEST'
     AND position('#{사업자} #{근무지}에서 소속 추가를 요청했습니다' IN "default_body") = 1
     AND jsonb_path_exists("default_variables", '$[*] ? (@.name == "사업자")');
  IF n <> 1 THEN
    RAISE EXCEPTION '소속 추가 확인 요청 메일의 기본 문구가 옛 첫 줄이 아니다: %', n;
  END IF;
END $$;

-- 지금 값: 첫 줄의 「#{사업자} 」는 늘 걷어낸다. 변수 사업자는 바꾼 본문과 제목에 #{사업자} 가 없을 때만 뺀다(SET 의 식은 바꾸기
-- 전 값을 보므로 본문은 replace 한 값으로 본다). 바뀔 것이 있는 행만 updated_at 을 올린다.
UPDATE "notification_templates"
   SET "body" = replace("body", '#{사업자} #{근무지}에서', '#{근무지}에서'),
       "variables" = CASE
         WHEN position('#{사업자}' IN replace("body", '#{사업자} #{근무지}에서', '#{근무지}에서')) = 0
          AND position('#{사업자}' IN COALESCE("title", '')) = 0
         THEN (
           SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality), '[]'::jsonb)
             FROM jsonb_array_elements("variables") WITH ORDINALITY AS e
            WHERE (e.value->>'name') IS DISTINCT FROM '사업자')
         ELSE "variables" END,
       "updated_at" = now()
 WHERE "template_code" = 'EMAIL_STAFF_AFFILIATION_REQUEST'
   AND (position('#{사업자}' IN "body") > 0 OR jsonb_path_exists("variables", '$[*] ? (@.name == "사업자")'));

-- 되돌리기 원본: 늘. updated_at 은 올리지 않는다 — 수정 화면의 낙관적 잠금(읽은 updatedAt)이 그 값이라, 운영자가 고친 템플릿을
-- 열어 둔 채 배포되면 지금 값은 그대로인데 저장이 409 가 된다(20261109165622 와 같다).
UPDATE "notification_templates"
   SET "default_body" = replace("default_body", '#{사업자} #{근무지}에서', '#{근무지}에서'),
       "default_variables" = (
         SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality), '[]'::jsonb)
           FROM jsonb_array_elements("default_variables") WITH ORDINALITY AS e
          WHERE (e.value->>'name') IS DISTINCT FROM '사업자')
 WHERE "template_code" = 'EMAIL_STAFF_AFFILIATION_REQUEST';

-- 검증: 되돌리기 원본은 새 첫 줄 그대로, 지금 값은 사업자가 남지 않았는지만 본다(나머지는 운영자가 고쳤을 수 있다).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'EMAIL_STAFF_AFFILIATION_REQUEST'
     AND position('#{근무지}에서 소속 추가를 요청했습니다' IN "default_body") = 1
     AND position('#{사업자}' IN "default_body") = 0
     AND jsonb_array_length("default_variables") = 3
     AND NOT jsonb_path_exists("default_variables", '$[*] ? (@.name == "사업자")');
  IF n <> 1 THEN
    RAISE EXCEPTION '소속 추가 확인 요청 메일의 기본 문구가 새 첫 줄로 바뀌지 않았다: %', n;
  END IF;
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'EMAIL_STAFF_AFFILIATION_REQUEST'
     AND (position('#{사업자}' IN COALESCE("title", '') || "body") > 0
          OR jsonb_path_exists("variables", '$[*] ? (@.name == "사업자")'));
  IF n <> 0 THEN
    RAISE EXCEPTION '소속 추가 확인 요청 메일(운영자가 고친 문구)에 사업자가 남았다 — 새 코드는 사업자를 넘기지 않아 메일이 나가지 않는다. 그 문구에서 #{사업자} 를 지우거나 기본으로 되돌린 뒤 다시 배포한다';
  END IF;
END $$;
