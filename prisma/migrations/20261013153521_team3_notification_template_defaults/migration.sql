-- 「기본 문구로 되돌리기」의 원본을 템플릿 행에 둔다(NOTIFY-17 · 18, 2026-10-13 재영). 지금까지 기본 문구는 마이그레이션 SQL 에만 있었다.
-- 되돌리면 제목 · 본문 · 변수 목록을 이 값으로 돌린다. 기본값이 빈 템플릿은 운영자가 등록한 것이라 되돌리기가 없다.
ALTER TABLE "notification_templates"
    ADD COLUMN "default_title" TEXT,
    ADD COLUMN "default_body" TEXT,
    ADD COLUMN "default_variables" JSONB;

ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_defaults_together" CHECK (("default_body" IS NULL) = ("default_variables" IS NULL) AND ("default_body" IS NOT NULL OR "default_title" IS NULL));
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_default_variables_array" CHECK ("default_variables" IS NULL OR jsonb_typeof("default_variables") = 'array');

COMMENT ON COLUMN "notification_templates"."default_title" IS '기본 제목 — 기본 문구로 되돌리기의 원본. 처음 넣은 40건만 (NOTIFY-17, 2026-10-13 재영)';
COMMENT ON COLUMN "notification_templates"."default_body" IS '기본 본문 — 기본 문구로 되돌리기의 원본. 없으면 등록한 템플릿이라 되돌리기가 없다';
COMMENT ON COLUMN "notification_templates"."default_variables" IS '기본 변수 목록 — 되돌리면 제목 · 본문과 함께 돌린다 (NOTIFY-18)';

-- 처음 넣은 40건은 이 마이그레이션 때까지 아무도 고치지 않았다(updated_by 가 비어 있고 변경 이력도 없다). 그 값이 곧 기본 문구다 —
-- 20261008000000 · 20261008000300 이 배포로 고친 문구까지 담긴다. 고친 흔적이 있는 행은 기본값을 정하지 않는다.
UPDATE "notification_templates" t
SET "default_title" = t."title", "default_body" = t."body", "default_variables" = t."variables"
WHERE t."updated_by" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "notification_template_histories" h WHERE h."notification_template_id" = t."notification_template_id");

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" WHERE "default_body" IS NOT NULL;
  IF n <> 40 THEN
    RAISE EXCEPTION '기본 문구를 복사한 템플릿이 40건이 아니다: %', n;
  END IF;
END $$;
