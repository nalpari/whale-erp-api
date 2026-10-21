-- 급여명세서를 다시 보낼 때도 처음 발송과 같은 문구를 쓴다 (쟁점 NOTI-6, 2026-10-20 재영 · 운영 정책 NTF-20, Plane #605).
-- 「다시 발송되었습니다」 · 「금액이 바뀌었을 수 있습니다」를 적지 않는다.
--
-- PUSH_PAYSLIP_RESENT · EMAIL_PAYSLIP_RESENT 의 제목 · 본문 · 변수 목록과 되돌리기 원본(default_*)을 각각
-- PUSH_PAYSLIP_SENT · EMAIL_PAYSLIP_SENT 의 되돌리기 원본과 같게 한다. 앱 푸시 변수 목록에 #{근무지}가 새로 들어간다.
-- 템플릿 코드 · 이름 · 채널 · 수신 설정 묶음 · 사용 여부는 그대로다.
--
-- 운영자가 이미 고친 문구는 덮어쓰지 않는다 — 제목 · 본문 · 변수 목록이 셋 다 옛 기본값 그대로일 때만 바꾼다.
-- 하나만 바꾸면 본문의 변수와 변수 목록이 어긋날 수 있어 셋을 같이 본다. 되돌리기 원본은 늘 바꾼다.
-- 발송 코드(#231 · #241)는 아직 없어 이 템플릿을 부르는 곳이 없다. 변경 이력은 남기지 않는다(20261019114505 와 같다).

UPDATE "notification_templates" AS r
   SET "title" = s."default_title", "body" = s."default_body", "variables" = s."default_variables",
       "updated_at" = now()
  FROM "notification_templates" AS s
 WHERE (r."template_code", s."template_code") IN (('PUSH_PAYSLIP_RESENT', 'PUSH_PAYSLIP_SENT'),
                                                   ('EMAIL_PAYSLIP_RESENT', 'EMAIL_PAYSLIP_SENT'))
   AND r."title" = r."default_title" AND r."body" = r."default_body" AND r."variables" = r."default_variables";

UPDATE "notification_templates" AS r
   SET "default_title" = s."default_title", "default_body" = s."default_body",
       "default_variables" = s."default_variables", "updated_at" = now()
  FROM "notification_templates" AS s
 WHERE (r."template_code", s."template_code") IN (('PUSH_PAYSLIP_RESENT', 'PUSH_PAYSLIP_SENT'),
                                                   ('EMAIL_PAYSLIP_RESENT', 'EMAIL_PAYSLIP_SENT'));

-- 검증은 되돌리기 원본만 본다 — 제목 · 본문 · 변수는 운영자가 고쳤을 수 있다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM "notification_templates" AS r
    JOIN "notification_templates" AS s
      ON (r."template_code", s."template_code") IN (('PUSH_PAYSLIP_RESENT', 'PUSH_PAYSLIP_SENT'),
                                                     ('EMAIL_PAYSLIP_RESENT', 'EMAIL_PAYSLIP_SENT'))
   WHERE r."default_title" = s."default_title" AND r."default_body" = s."default_body"
     AND r."default_variables" = s."default_variables"
     AND position('다시 발송' IN r."default_title") = 0;
  IF n <> 2 THEN
    RAISE EXCEPTION '급여명세서 다시 발송 기본 문구가 처음 발송과 같아지지 않았다: %', n;
  END IF;
END $$;
