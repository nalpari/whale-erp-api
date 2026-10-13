-- 운영 알림 · 직원 알림의 제목 칸(NOTIFY-12, 2026-10-13 재영 결정). 템플릿의 제목을 만들 때 박아 두고 알림함 목록 · 종 팝오버가 쓴다.
-- 지금까지 body 하나뿐이라 제목을 담을 곳이 없었다. 이 마이그레이션을 만들 때 공용 DB 의 notifications 는 0건이라 기본값 없이 NOT NULL 로 더한다.
ALTER TABLE "notifications" ADD COLUMN "title" TEXT NOT NULL;

COMMENT ON COLUMN "notifications"."title" IS '알림 제목 — 만들 때의 템플릿 제목을 박아 둠 — 알림함 목록 · 종 팝오버 (NOTIFY-12, 2026-10-13 재영)';
COMMENT ON COLUMN "notifications"."body" IS '알림 내용 — 템플릿 둘째 줄';
