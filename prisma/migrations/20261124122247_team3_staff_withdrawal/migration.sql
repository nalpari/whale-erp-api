-- 직원 앱 회원 탈퇴 (WHALEERP-770, 2026-11-24 노영주 확정).
--
-- 탈퇴한 계정은 행을 지우지 않고(직원 레코드 · 계약 · 출퇴근이 account_id 로 이어진다) 개인정보 칸을 비운다. 그래서
-- email · password_hash · real_name · birth_date · phone 의 NOT NULL 을 푼다. 대신 「탈퇴가 아니면 이 다섯 칸은 있다」를 CHECK 로
-- 건다 — 탈퇴 아닌 계정에 NULL 이 새는 것을 DB 가 막는다. 기존 행은 모두 NOT NULL 이라 이 CHECK 를 만족한다(ADD CONSTRAINT 가 기존 행을 검증한다).
--
-- 롤백 주의: 탈퇴한 행이 생긴 뒤에는 SET NOT NULL 로 되돌릴 수 없다(NULL 행이 있다).
--
-- accounts_email_lower · accounts_phone_format 은 고치지 않는다 — CHECK 는 NULL 이면 통과라 이미 NULL 을 허용한다.
-- 로그인 아이디(email) 고유 인덱스도 그대로다 — NULL 끼리는 겹치지 않아 탈퇴 계정이 여럿이어도 된다(옛 이메일로 다시 가입도 된다).
--
-- 템플릿 두 건 — 문구는 임시다(기획 확인 뒤 템플릿 관리 화면에서 고친다). 형식은 20261027154954_team3_affiliation_request_templates 를 따른다.
--   NTF_STAFF_WITHDRAWN        운영 알림 — 직원 계정 탈퇴를 근무지 관리자에게 알린다. 변수: 직원이름 · 근무지
--   EMAIL_STAFF_WITHDRAW_DONE  직원 메일 — 탈퇴 완료. 지우기 전에 읽어 둔 이메일로 간다. 변수: 직원이름

ALTER TABLE "accounts" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "accounts" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "accounts" ALTER COLUMN "real_name" DROP NOT NULL;
ALTER TABLE "accounts" ALTER COLUMN "birth_date" DROP NOT NULL;
ALTER TABLE "accounts" ALTER COLUMN "phone" DROP NOT NULL;

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_personal_required_unless_withdrawn" CHECK ("status" = 'WITHDRAWN' OR ("email" IS NOT NULL AND "password_hash" IS NOT NULL AND "real_name" IS NOT NULL AND "birth_date" IS NOT NULL AND "phone" IS NOT NULL));

INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables", "kakao_template_code",
   "default_title", "default_body", "default_variables", "is_active")
SELECT v."code", v."channel"::"notification_template_channel", v."name", NULL, v."title", v."body", v."variables", NULL,
       v."title", v."body", v."variables", true
  FROM (VALUES
    ('NTF_STAFF_WITHDRAWN', 'NOTIFICATION', '직원 계정 탈퇴', '#{직원이름} 님이 직원 앱 계정을 탈퇴했습니다.', '- 근무지: #{근무지}',
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb),
    ('EMAIL_STAFF_WITHDRAW_DONE', 'EMAIL', '직원 회원 탈퇴 완료', '[WHALE ERP] 회원 탈퇴 완료', '#{직원이름} 님의 WHALE ERP 직원 계정 탈퇴가 완료되었습니다.
근로계약서 · 급여명세서 · 출퇴근 기록은 근무지가 법정 보존 기간 동안 보관합니다.',
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}]'::jsonb)
  ) AS v("code", "channel", "name", "title", "body", "variables");

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('NTF_STAFF_WITHDRAWN', 'EMAIL_STAFF_WITHDRAW_DONE') AND "is_active"
     AND "body" = "default_body" AND "variables" = "default_variables";
  IF n <> 2 THEN
    RAISE EXCEPTION '직원 탈퇴 템플릿 2건이 들어가지 않았다: %', n;
  END IF;
END $$;
