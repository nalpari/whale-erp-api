-- 근로계약서 발송 알림톡(WHALEERP-619, 2026-11-02 김민식 — 카카오(비즈뿌리오) 등록 완료).
--
-- 가입한 직원에게 근로계약서를 보내면(저장 · 재발송 · 수정 요청 계약을 고쳐 다시 보냄) 직원 알림함 PUSH_CONTRACT_SENT 와 같은 때
-- 알림톡도 간다 — 1차에는 앱 푸시가 없어 알림톡이 바깥으로 나가는 유일한 길이다(운영 정책 NTF-18 v262). 수신 설정에서 근로계약서
-- 묶음을 끈 직원에게는 보내지 않는다 — 알림톡 템플릿에는 묶음을 둘 수 없어(CHECK notification_templates_preference_category_push_only)
-- api 가 알림함 템플릿의 판정을 따른다.
--
-- 본문은 카카오 등록본 그대로다(빈 줄 두 개, 다섯 줄 — 알림함 PUSH_CONTRACT_SENT 본문과 같은 문장). 버튼은 없다 — 등록본에 버튼이
-- 없어 버튼을 실으면 카카오가 거절하므로 버튼 링크 변수도 두지 않는다(대체 문자에도 링크가 붙지 않는다).
-- 카카오 템플릿 코드는 PUSH_CONTRACT_SENT 로 등록됐다 — 알림함 템플릿 코드와 이름이 같지만 다른 템플릿이다. 우리 템플릿 코드는 겹치지
-- 않게 TALK_STAFF_CONTRACT_SENT 로 두고 kakao_template_code 에만 그 값을 넣는다.
-- 변수: 근무지(점포 이름) · 날인기한(「10월 30일」 꼴 — 알림함과 같다).
--
-- 문자열은 달러 인용($t$ … $t$)이라 줄바꿈이 등록본 그대로다. 저장소에 .gitattributes 가 없어 Windows 체크아웃(autocrlf)은 이 파일을
-- CRLF 로 바꾸므로 \r 을 지워 넣고, 등록본 전체가 같은지 · \r 이 없는지 검증한다(20261030174743 과 같다).

CREATE TEMP TABLE "_contract_sent_registered" AS
SELECT replace($t$#{근무지}에서 근로계약서를 보냈습니다.

- 서명 기한: #{날인기한}

계약 내용을 확인하고 서명해 주세요.$t$, E'\r', '') AS "body",
       '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "날인기한", "label": "날인 기한", "isRequired": true, "sampleValue": "10월 30일"}]'::jsonb AS "variables";

INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables", "kakao_template_code",
   "default_title", "default_body", "default_variables", "is_active")
SELECT 'TALK_STAFF_CONTRACT_SENT', 'ALIMTALK'::"notification_template_channel", '근로계약서 발송 알림톡', NULL, NULL, t."body", t."variables",
       'PUSH_CONTRACT_SENT', NULL, t."body", t."variables", true
  FROM "_contract_sent_registered" AS t;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r, "_contract_sent_registered" AS t
   WHERE r."template_code" = 'TALK_STAFF_CONTRACT_SENT'
     AND r."channel" = 'ALIMTALK'
     AND r."is_active"
     AND r."kakao_template_code" = 'PUSH_CONTRACT_SENT'
     AND r."title" IS NULL
     AND r."body" = t."body" AND r."default_body" = t."body"
     AND position(E'\r' IN r."body") = 0
     AND array_length(string_to_array(r."body", E'\n'), 1) = 5
     AND r."variables" = t."variables" AND r."default_variables" = t."variables"
     AND NOT jsonb_path_exists(r."variables", '$[*] ? (@.isButtonLink == true)');
  IF n <> 1 THEN
    RAISE EXCEPTION '근로계약서 발송 알림톡 템플릿이 카카오 등록본과 같게 들어가지 않았다: %', n;
  END IF;
END $$;

DROP TABLE "_contract_sent_registered";
