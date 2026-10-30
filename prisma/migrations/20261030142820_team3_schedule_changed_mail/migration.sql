-- 근무스케줄 변경 메일 (WHALEERP-639, 2026-10-30 재영 — 운영 정책 NTF-14 · NTF-18 v262).
--
-- 가입한 직원의 알림톡은 근로계약서 발송 하나로 줄었고(#619), 근무스케줄 변경은 메일로 보낸다. 직원 알림함 줄 · 앱 푸시
-- 발송 대기(PUSH_SCHEDULE_CHANGED)와 같은 때 계정의 이메일로 간다. 본문은 PUSH_SCHEDULE_CHANGED 의 문구(20261030093710)와 같은
-- 문장이고, 제목은 다른 메일처럼 [WHALE ERP] 를 앞에 붙인다. 버튼(링크)은 직원 근무 앱 근무 탭이다.
-- 수신 설정 묶음은 두지 않는다 — CHECK notification_templates_preference_category_push_only. 메일을 보낼지는 api 가 앱 푸시
-- 템플릿의 묶음 판정을 따른다.

INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables", "kakao_template_code",
   "default_title", "default_body", "default_variables", "is_active")
SELECT 'EMAIL_SCHEDULE_CHANGED', 'EMAIL'::"notification_template_channel", '근무스케줄 변경 메일', NULL, v."title", v."body", v."variables", NULL,
       v."title", v."body", v."variables", true
  FROM (VALUES
    ($t$[WHALE ERP] 근무스케줄 변경$t$, $t$#{근무지} 근무스케줄이 변경되었습니다.

- 변경 내용: #{변경내용}

직원 근무 앱에서 바뀐 스케줄을 확인해 주세요.$t$,
     '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "변경내용", "label": "바뀐 근무 요약", "isRequired": true, "sampleValue": "10월 9일(목) 09:00~15:00 → 12:00~18:00"}, {"name": "링크", "label": "직원 근무 앱 근무 탭(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…/work", "isButtonLink": true}]'::jsonb)
  ) AS v("title", "body", "variables");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "notification_templates"
                  WHERE "template_code" = 'EMAIL_SCHEDULE_CHANGED' AND "is_active"
                    AND "body" = "default_body" AND "variables" = "default_variables" AND jsonb_array_length("variables") = 3) THEN
    RAISE EXCEPTION '근무스케줄 변경 메일 템플릿이 들어가지 않았다';
  END IF;
END $$;
