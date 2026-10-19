-- 가입 초대 알림톡 TALK_STAFF_INVITATION 을 초대 링크(토큰)에서 초대 코드로 바꾼다 (2026-10-19 김민식 결정, WHALEERP-136 · 141).
--
-- 직원은 알림톡의 앱 설치 링크로 직원 앱을 설치 · 가입한 뒤, 본문의 초대 코드(대문자 영문 · 숫자 6자리)를 입력한다.
-- 변수: 근무지 · 초대코드(본문) · 링크(앱 설치 링크, 버튼). 되돌리기 원본(default_*)도 같은 값으로 바꾼다. 제목 · 채널 ·
-- 카카오 템플릿 코드(WHALE_INVITE_01)는 그대로다 — 카카오 템플릿 문구도 이 본문에 맞춰 다시 검수받아야 한다.
-- 운영 전이라 마이그레이션으로 고친다. 변경 이력은 남기지 않는다.
-- 발송 코드(ContractDeliveryService)는 초대코드를 넘긴다 — 이 파일이 적용되기 전에는 「없는 변수」로 가입 초대가 막히고(보내기 전
-- 실패라 저장을 되돌림), 적용한 뒤에는 거꾸로 초대코드를 넘기지 않는 옛 코드가 필수 변수 누락으로 막힌다. 머지 직후 바로 deploy 한다.

UPDATE "notification_templates"
   SET "body" = v."body", "default_body" = v."body",
       "variables" = v."variables", "default_variables" = v."variables",
       "updated_at" = now()
  FROM (VALUES ('#{근무지}에서 근로계약서를 보내려고 합니다.
아래 링크로 WHALE ERP 직원 근무 앱을 설치해 가입한 뒤, 초대 코드를 입력해 주세요.
초대 코드: #{초대코드}
초대 코드는 30일 동안 쓸 수 있습니다.', '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "초대코드", "label": "초대 코드(대문자 영문 · 숫자 6자리)", "isRequired": true, "sampleValue": "K7Q2M9"}, {"name": "링크", "label": "직원 앱 설치 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb)) AS v("body", "variables")
 WHERE "template_code" = 'TALK_STAFF_INVITATION';

-- 검증은 이번에 바꾼 칸만 본다 — 제목 · 채널은 템플릿 관리 화면에서 고칠 수 있다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'TALK_STAFF_INVITATION'
     AND position('#{초대코드}' IN "body") > 0
     AND "body" = "default_body"
     AND "variables" = "default_variables" AND jsonb_array_length("variables") = 3
     AND "variables" -> 1 ->> 'name' = '초대코드';
  IF n <> 1 THEN
    RAISE EXCEPTION 'TALK_STAFF_INVITATION 이 초대 코드 본문으로 바뀌지 않았다: %', n;
  END IF;
END $$;
