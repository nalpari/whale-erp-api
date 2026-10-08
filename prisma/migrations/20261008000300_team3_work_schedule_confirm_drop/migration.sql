-- 3팀 근무스케줄 확정 단계 없앰 (2026-10-08 재영, 운영 정책 PAY-14 v90 · Plane #201 · #197).
--
-- 근무스케줄은 저장하면 바로 직원 근무 앱에 반영된다. 확정 전 · 확정을 나누던 work_schedules.confirm_status 와
-- 그 enum work_schedule_confirm_status 를 지운다. 이 칸을 읽는 코드는 없다. 저장 알림(이번 저장에서 등록 · 수정 · 삭제된
-- 직원에게 앱 푸시 한 번)은 스키마가 아니라 api 몫이다.
--
-- 같은 결정으로 알림 이름 「근무스케줄 주요 변경」을 「근무스케줄 변경」으로 바꾼다. 이미 적용된
-- 20261007000200_team3_notification_templates 가 넣은 PUSH_SCHEDULE_CHANGED 의 template_name 을 고친다. 운영자가
-- 화면에서 이미 다른 이름으로 바꿨다면 건드리지 않도록 옛 이름일 때만 바꾼다.
--
-- 본문은 docs/raw/2026-10-06-3팀-schema.sql(물리 생성기 출력)에서 빠진 줄에 맞춘 것이다. 칸을 먼저 지워야 타입을 지울 수 있다.

ALTER TABLE "work_schedules" DROP COLUMN "confirm_status";
DROP TYPE "work_schedule_confirm_status";

UPDATE "notification_templates"
   SET "template_name" = '근무스케줄 변경', "updated_at" = now()
 WHERE "template_code" = 'PUSH_SCHEDULE_CHANGED' AND "template_name" = '근무스케줄 주요 변경';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'work_schedules' AND column_name = 'confirm_status')
     OR EXISTS (SELECT 1 FROM pg_type WHERE typname = 'work_schedule_confirm_status') THEN
    RAISE EXCEPTION '근무스케줄 확정 상태 칸이나 enum 이 남아 있다';
  END IF;
  IF EXISTS (SELECT 1 FROM "notification_templates" WHERE "template_name" = '근무스케줄 주요 변경') THEN
    RAISE EXCEPTION '옛 알림 이름 「근무스케줄 주요 변경」이 남아 있다';
  END IF;
END $$;
