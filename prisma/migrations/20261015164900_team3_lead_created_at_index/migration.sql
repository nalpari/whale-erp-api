-- 접수 확인 메일의 서비스 전체 시간당 상한(50건)이 최근 1시간 도입문의를 센다(api #50 리뷰, 재영 2026-10-15).
-- 접수마다 세므로 인덱스가 없으면 그때마다 leads 를 끝까지 훑는다.
CREATE INDEX "leads_created_at_idx" ON "leads" ("created_at");
