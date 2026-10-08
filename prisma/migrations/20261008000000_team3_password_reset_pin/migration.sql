-- 3팀 비밀번호 재설정 핀 정리 (2026-10-08 재영 승인, 노영주 제안 · 운영 정책 ACC-08 · ACC-09).
--
-- 바뀐 규칙: 핀은 낸 시각부터 10분, 시계 하나로 센다. 핀 쿨다운은 없앤다 — 5회 틀리면 그 핀은 닫히고 새 핀을 받는다.
-- 새 비밀번호를 저장할 때 핀을 다시 받아 검증한다(그때 used_at 을 남긴다).
--
-- 1) password_reset_pins 의 쿨다운 칸 둘(cooldown_step · cooldown_expires_at)과 그 CHECK 를 지운다(재영: 지움).
--    「5회 실패로 닫힘」은 칸을 두지 않는다 — attempt_count = 5 가 곧 닫힌 핀이다(CHECK 가 5 를 넘지 못하게 한다).
-- 2) 기본 알림 템플릿 EMAIL_STAFF_PASSWORD_PIN 본문의 「15분」을 「10분」으로. 운영 전이라 마이그레이션으로 고친다 —
--    운영에 들어간 뒤 문구는 화면에서만 고친다(운영 정책 NTF-26). EMAIL_CHANGE_PIN(이메일 변경 핀, 15분)은 그대로다.
--
-- 표 쪽 줄은 docs/raw/2026-10-06-3팀-schema.sql(물리 생성기 출력)의 차이에서 옮겼다. 같은 차이에 섞여 있는
-- accounts.status 주석(탈퇴 추가)은 노영주 님 마이그레이션(20261007100000_account_status_withdrawn) 몫이라 넣지 않는다.

ALTER TABLE "password_reset_pins" DROP CONSTRAINT "password_reset_pins_cooldown_step_range";
ALTER TABLE "password_reset_pins" DROP COLUMN "cooldown_step", DROP COLUMN "cooldown_expires_at";

COMMENT ON COLUMN "password_reset_pins"."expires_at" IS '만료 시각 — 발급 시각부터 10분 (2026-10-08)';
COMMENT ON COLUMN "password_reset_pins"."attempt_count" IS '시도 횟수 — 5회 틀리면 그 핀은 닫힘, 새 핀을 받는다';
COMMENT ON COLUMN "password_reset_pins"."used_at" IS '사용 시각 — 새 비밀번호 저장 때 핀을 다시 검증하고 남김';

-- ── 템플릿 본문 · 검사 ──
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "notification_templates"
     SET "body" = replace("body", '핀은 15분 동안 쓸 수 있습니다', '핀은 10분 동안 쓸 수 있습니다'),
         "updated_at" = now()
   WHERE "template_code" = 'EMAIL_STAFF_PASSWORD_PIN'
     AND position('핀은 15분 동안 쓸 수 있습니다' IN "body") > 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'EMAIL_STAFF_PASSWORD_PIN 본문에서 「핀은 15분 동안 쓸 수 있습니다」를 찾지 못했다(바뀐 행 %)', n;
  END IF;
  IF (SELECT position('핀은 10분 동안 쓸 수 있습니다' IN "body") FROM "notification_templates"
       WHERE "template_code" = 'EMAIL_STAFF_PASSWORD_PIN') = 0 THEN
    RAISE EXCEPTION 'EMAIL_STAFF_PASSWORD_PIN 본문이 10분으로 바뀌지 않았다';
  END IF;
  IF (SELECT position('15분' IN "body") FROM "notification_templates"
       WHERE "template_code" = 'EMAIL_CHANGE_PIN') = 0 THEN
    RAISE EXCEPTION 'EMAIL_CHANGE_PIN 본문의 15분은 그대로여야 한다';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'password_reset_pins' AND column_name IN ('cooldown_step', 'cooldown_expires_at')) THEN
    RAISE EXCEPTION '쿨다운 칸이 남아 있다';
  END IF;
END $$;
