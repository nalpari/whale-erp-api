-- 도입문의 접수 확인 메일 EMAIL_LEAD_CONFIRMATION 을 고정 문구로 (재영 결정 2026-10-15, api #50 리뷰 · 운영 정책 CNT-11 v133).
--
-- 비로그인 접수라 받는 주소가 확인되지 않았다. 본문의 #{도입문의자}(이름 · 업종)에 접수자가 넣은 글이 그대로 실려,
-- 남의 주소로 회사 명의 피싱 문구를 보낼 수 있었다. 그래서 입력값을 싣지 않는다 — 본문을 고정 문구로, 변수 목록을 [] 로.
-- 되돌리기 원본(default_*)도 같은 값으로 바꾼다. 제목은 그대로다.
-- 운영 전이라 마이그레이션으로 고친다(20261008000000 과 같다). 변경 이력은 남기지 않는다.
-- 발송 코드(LeadsService)는 이 템플릿에 변수를 넘기지 않는다 — 이 파일이 적용되기 전에는 필수 변수가 빠져 메일만 막힌다.

UPDATE "notification_templates"
   SET "body" = v."body", "default_body" = v."body",
       "variables" = '[]'::jsonb, "default_variables" = '[]'::jsonb,
       "updated_at" = now()
  FROM (VALUES ('WHALE ERP 도입문의가 접수되었습니다.

담당자가 영업일 기준 1~2일 안에 남겨 주신 연락처로 연락드리겠습니다.')) AS v("body")
 WHERE "template_code" = 'EMAIL_LEAD_CONFIRMATION';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'EMAIL_LEAD_CONFIRMATION' AND "channel" = 'EMAIL'
     AND position('#{' IN "body") = 0 AND "body" = "default_body"
     AND "variables" = '[]'::jsonb AND "default_variables" = '[]'::jsonb
     AND "title" = '[WHALE ERP] 도입문의가 접수되었습니다';
  IF n <> 1 THEN
    RAISE EXCEPTION 'EMAIL_LEAD_CONFIRMATION 이 고정 문구로 바뀌지 않았다: %', n;
  END IF;
END $$;
