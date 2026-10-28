-- 소속 추가 확인 요청 알림톡 · 메일 (WHALEERP-130, 2026-10-26 재영 — 이미 가입한 직원에게 새 점포가 첫 계약을 보낼 때 「점포 연결」 단계).
--
-- 계정이 있는 번호의 근로계약서를 저장하면 계약은 발송 대기로 두고 직원에게 「소속 추가 확인 요청」을 알림톡 · 메일로 보낸다(복귀
-- 확인 — 같은 점포에서 퇴직했던 직원 — 도 같은 요청이다). 직원은 직원 앱에 로그인해 요청 화면(`/affiliations`)에서 수락 · 거절한다.
-- 링크에는 토큰을 싣지 않는다 — 요청은 그 번호의 계정에 걸려 로그인해야 열린다.
--
-- 알림톡 TALK_STAFF_AFFILIATION_REQUEST 의 카카오 템플릿 코드 WHALE_AFFILIATION_01 은 아직 카카오에 등록 · 검수되지 않았다
-- (2026-10-27 김민식 — 검수 전에는 대체 문자로 먼저 보낸다). 등록 전에는 비즈뿌리오가 알림톡을 거절하고 대체 문자(본문 + 링크)로
-- 간다. 카카오에 등록할 때 이 본문 그대로 등록하고, 코드가 다르면 템플릿 관리 화면에서 고친다. 메일 EMAIL_STAFF_AFFILIATION_REQUEST
-- 는 계정의 이메일로 간다. 문구는 초안이다 — 기획 확인 뒤 템플릿 관리 화면에서 고친다.
-- 변수: 사업자(BP 상호) · 근무지(점포 이름) · 고용형태(정직원 · 파트타이머) · 링크(직원 앱 요청 화면, 버튼).

INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables", "kakao_template_code",
   "default_title", "default_body", "default_variables", "is_active")
SELECT v."code", v."channel"::"notification_template_channel", '소속 추가 확인 요청', NULL, v."title", v."body", v."variables", v."kakao",
       v."title", v."body", v."variables", true
  FROM (VALUES
    ('TALK_STAFF_AFFILIATION_REQUEST', 'ALIMTALK', NULL, '#{사업자} #{근무지}에서 소속 추가를 요청했습니다.
고용 형태: #{고용형태}
WHALE ERP 직원 근무 앱에 로그인해 요청을 확인하고 수락하면 근로계약서를 받을 수 있습니다.
요청은 30일 동안 유효합니다.',
     '[{"name": "사업자", "label": "사업자(BP) 상호", "isRequired": true, "sampleValue": "모리커피"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "고용형태", "label": "고용 형태", "isRequired": true, "sampleValue": "파트타이머"}, {"name": "링크", "label": "직원 앱 요청 화면(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…/affiliations", "isButtonLink": true}]'::jsonb,
     'WHALE_AFFILIATION_01'),
    ('EMAIL_STAFF_AFFILIATION_REQUEST', 'EMAIL', '[WHALE ERP] #{근무지}에서 소속 추가를 요청했습니다', '#{사업자} #{근무지}에서 소속 추가를 요청했습니다(고용 형태: #{고용형태}).
WHALE ERP 직원 근무 앱에 로그인해 요청을 확인해 주세요. 수락하면 근로계약서를 받아 날인할 수 있고, 거절해도 지금 소속과 계정에는 영향이 없습니다.
요청은 30일 동안 유효합니다.',
     '[{"name": "사업자", "label": "사업자(BP) 상호", "isRequired": true, "sampleValue": "모리커피"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "고용형태", "label": "고용 형태", "isRequired": true, "sampleValue": "파트타이머"}, {"name": "링크", "label": "직원 앱 요청 화면(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…/affiliations", "isButtonLink": true}]'::jsonb,
     NULL)
  ) AS v("code", "channel", "title", "body", "variables", "kakao");

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('TALK_STAFF_AFFILIATION_REQUEST', 'EMAIL_STAFF_AFFILIATION_REQUEST') AND "is_active"
     AND "body" = "default_body" AND "variables" = "default_variables" AND jsonb_array_length("variables") = 4;
  IF n <> 2 THEN
    RAISE EXCEPTION '소속 추가 확인 요청 템플릿 2건이 들어가지 않았다: %', n;
  END IF;
END $$;
