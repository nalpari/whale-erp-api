-- 직원 앱 가입(WHALEERP-601 · 141 · 142, 진입 · 가입 화면 가이드 JOIN-7 · 2026-10-20 김민식).
--
-- 1. 계정에 성별 · 외국인 여부. 가입은 본인인증 없이 직원이 이름 · 휴대전화번호 · 생년월일 · 성별 · 외국인 여부를 넣고,
--    날인 때 근로계약서에 관리자가 넣은 값(contract_parties.entered_* · is_foreigner)과 대조한다(WHALEERP-125 「본인 대조」).
--    성별은 고르지 않을 수 있어 NULL 허용, 외국인 여부는 체크라 늘 값이 있다 — 이미 있는 계정은 성별 없음 · 내국인으로
--    시작한다. 타입 gender 는 20261016133630 이 만들었다.
-- 2. 운영 알림 NTF_SIGNUP_UNDER_AGE — 가입하는 직원이 넣은 생년월일이 만 19세 미만이면 계정을 만들지 않고 초대를
--    「가입 불가(만 19세 미만)」로 두며 그 점포 관리자에게 알린다(운영 정책 ACC-22). 생년월일은 알림에 싣지 않는다.
--    문구는 초안이다 — 기획 확인 뒤 템플릿 관리 화면에서 고친다.

-- AlterTable
ALTER TABLE "accounts"
    ADD COLUMN "gender" "gender",
    ADD COLUMN "is_foreigner" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "accounts"."gender" IS '성별 — 남 · 여 — 가입 때 직원이 넣은 값, 계약서 값과 본인 대조 (WHALEERP-601, 2026-10-20) (물리에서 추가)';
COMMENT ON COLUMN "accounts"."is_foreigner" IS '외국인 여부 — 체크하지 않으면 내국인 — 가입 때 직원이 넣은 값, 계약서 값과 본인 대조 (WHALEERP-601, 2026-10-20) (물리에서 추가)';

INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables",
   "default_title", "default_body", "default_variables", "is_active")
SELECT v."code", 'NOTIFICATION', '가입 불가(만 19세 미만)', NULL, v."title", v."body", v."variables",
       v."title", v."body", v."variables", true
  FROM (VALUES ('NTF_SIGNUP_UNDER_AGE',
                '#{직원이름} 님이 만 19세 미만이라 가입하지 못했습니다',
                '#{근무지} · 생년월일을 확인하고 근로계약서를 정리해 주세요',
                '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb))
       AS v("code", "title", "body", "variables");

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'NTF_SIGNUP_UNDER_AGE' AND "channel" = 'NOTIFICATION' AND "is_active"
     AND "body" = "default_body" AND "title" = "default_title" AND jsonb_array_length("variables") = 2;
  IF n <> 1 THEN
    RAISE EXCEPTION 'NTF_SIGNUP_UNDER_AGE 템플릿이 들어가지 않았다: %', n;
  END IF;
END $$;
