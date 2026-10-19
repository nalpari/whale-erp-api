-- 가입 연결 보류 기본 템플릿 2건을 사용 안 함으로 둔다 (2026-10-19 재영 결정, 운영 정책 v135).
--
-- 연결 보류 · 가입 연결 확인을 없앴다 — 번호 · 이름 등이 다르면 본인 대조 불일치로 보고 직원이 수정을 요청한다(JOI-10 ·
-- CTR-27). 이 템플릿을 보내는 코드는 없다. 행은 지우지 않는다(템플릿 관리 화면 · 되돌리기 원본이 행을 본다).
-- 이미 꺼져 있어도 같은 결과라 다시 돌려도 된다.

UPDATE "notification_templates"
   SET "is_active" = false, "updated_at" = now()
 WHERE "template_code" IN ('NTF_LINK_HOLD', 'EMAIL_LINK_HOLD')
   AND "is_active";

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('NTF_LINK_HOLD', 'EMAIL_LINK_HOLD') AND "is_active";
  IF n <> 0 THEN
    RAISE EXCEPTION '가입 연결 보류 템플릿이 아직 켜져 있다: %', n;
  END IF;
END $$;
