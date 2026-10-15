-- 도입문의 답변 메일 기본 템플릿 1건 (WHALEERP-588, 2026-10-14 재영). 기본 템플릿이 40건 → 41건(메일 24 → 25)이 된다.
--
-- 운영자가 도입문의에 처음 답변하면 문의자가 적은 이메일로 답변 본문을 보낸다. 고쳐도 다시 보내지 않는다. 비로그인
-- 문의자라 버튼 링크 변수는 없고, 내부 메모는 넣지 않는다. 운영 알림은 붙이지 않는다(운영 정책 NTF-03).
-- 기본 문구로 되돌리기의 원본(default_*)도 처음부터 같은 값으로 채운다(NOTIFY-17 · 18, 20261013153521).

INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables", "kakao_template_code", "is_active",
   "default_title", "default_body", "default_variables")
SELECT v."template_code", 'EMAIL', v."template_name", NULL, v."title", v."body", v."variables", NULL, true,
       v."title", v."body", v."variables"
FROM (VALUES
  ('EMAIL_LEAD_REPLY', '도입문의 답변 메일', '[WHALE ERP] 도입문의에 답변드립니다', '#{문의자이름} 님, 남겨 주신 WHALE ERP 도입문의에 답변드립니다.

#{답변}', '[{"name": "문의자이름", "label": "도입문의 이름", "isRequired": true, "sampleValue": "김도윤"}, {"name": "답변", "label": "답변 본문", "isRequired": true, "sampleValue": "다음 주 화요일 오후에 방문 상담드리겠습니다."}]'::jsonb)
) AS v("template_code", "template_name", "title", "body", "variables");

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
  WHERE "template_code" = 'EMAIL_LEAD_REPLY' AND "channel" = 'EMAIL' AND "is_active" AND "default_body" IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'EMAIL_LEAD_REPLY 기본 템플릿이 1건이 아니다: %', n;
  END IF;
END $$;
