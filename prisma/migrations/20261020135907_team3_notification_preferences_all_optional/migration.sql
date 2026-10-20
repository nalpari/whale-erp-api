-- 수신 설정 묶음 네 개(근로계약서 · 근무스케줄 · TO-DO · 급여명세서) 모두 직원이 켜고 끈다. 꺼도 알림함에는 남는다
-- (쟁점 NOTI-8, 2026-10-20 재영, 운영 정책 NTF-14 v151). 근로계약서 · 급여명세서를 끌 수 없게 하던 CHECK 를 지운다.
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_mandatory_enabled";

COMMENT ON COLUMN "notification_preferences"."is_enabled" IS '수신 여부 — 기본 켬 — 네 묶음 모두 직원이 끈다. 꺼도 알림함에는 남는다 (NOTI-8, 2026-10-20 재영) (논리 enabled)';
