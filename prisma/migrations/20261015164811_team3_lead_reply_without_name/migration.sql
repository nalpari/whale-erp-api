-- 도입문의 답변 메일 EMAIL_LEAD_REPLY 에서 문의자이름을 뺀다 (재영 결정 2026-10-15, 운영 정책 CNT-11 v134, WHALEERP-588).
--
-- 비로그인 접수라 받는 주소가 확인되지 않았다. #{문의자이름} 에 접수자가 넣은 글이 그대로 실려 남의 주소로 회사 명의
-- 문구를 보낼 수 있다 — 접수 확인 메일을 고정 문구로 바꾼 20261015155556 과 같은 이유다. 답변은 운영자가 쓴 글이라 둔다.
-- 되돌리기 원본(default_*)도 같은 값으로 바꾼다. 제목은 그대로다.
-- 운영 전이라 마이그레이션으로 고친다. 변경 이력은 남기지 않는다.
-- 발송 코드(LeadsAdminService)는 답변만 넘긴다 — 이 파일이 적용되기 전에는 필수 변수 문의자이름이 빠져 답변 메일만 막힌다.
-- 적용한 뒤에는 거꾸로 문의자이름을 넘기는 옛 코드가 「없는 변수」로 막힌다. 머지 직후 바로 deploy 하고, 그 사이 막힌
-- 답변 메일(서버 로그 lead reply mail FAILED)은 다시 나가지 않으므로 손으로 보낸다.

UPDATE "notification_templates"
   SET "body" = v."body", "default_body" = v."body",
       "variables" = v."variables", "default_variables" = v."variables",
       "updated_at" = now()
  FROM (VALUES ('남겨 주신 WHALE ERP 도입문의에 답변드립니다.

#{답변}', '[{"name": "답변", "label": "답변 본문", "isRequired": true, "sampleValue": "다음 주 화요일 오후에 방문 상담드리겠습니다."}]'::jsonb)) AS v("body", "variables")
 WHERE "template_code" = 'EMAIL_LEAD_REPLY';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'EMAIL_LEAD_REPLY' AND "channel" = 'EMAIL'
     AND position('#{문의자이름}' IN "body") = 0 AND position('#{답변}' IN "body") > 0
     AND "body" = "default_body"
     AND "variables" = "default_variables" AND jsonb_array_length("variables") = 1
     AND "variables" -> 0 ->> 'name' = '답변'
     AND "title" = '[WHALE ERP] 도입문의에 답변드립니다';
  IF n <> 1 THEN
    RAISE EXCEPTION 'EMAIL_LEAD_REPLY 에서 문의자이름이 빠지지 않았다: %', n;
  END IF;
END $$;
