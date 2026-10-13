-- 알림을 눌러 갈 업무 화면을 알림을 만드는 업무 쪽이 넘긴다(NOTIFY-16, 2026-10-13 재영). 운영 알림 쪽은 업무 화면 경로를 모른다.
-- 갈 화면이 없는 알림도 있어 비어도 된다. 관리자 웹 안의 경로만 받는다 — 바깥 주소 · // · 백슬래시 · 공백은 막는다.
ALTER TABLE "notifications" ADD COLUMN "link" TEXT;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_link_internal_path" CHECK ("link" IS NULL OR ("link" LIKE '/%' AND "link" NOT LIKE '//%' AND "link" !~ '[\\[:space:]]'));

COMMENT ON COLUMN "notifications"."link" IS '업무 링크 — 알림을 눌러 갈 관리자 웹 경로. 알림을 만드는 업무 쪽이 넘긴다, 없으면 알림함에서 안내 (NOTIFY-16, 2026-10-13 재영)';
