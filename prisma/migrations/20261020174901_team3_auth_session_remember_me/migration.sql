-- 직원 앱 로그인의 「자동 로그인」 (2026-10-20 노영주, 운영 정책 LOGIN-4 를 바꾼다). 켜면 지금처럼 마지막 사용 후 30일,
-- 끄면 마지막 사용 후 7일 — 갱신할 때마다 그 세션의 길이로 다시 민다. 갱신이 그 세션의 길이를 알아야 해서 접속 상태에
-- 칸을 둔다. 기본값 true 라 이미 있는 접속은 모두 지금처럼 30일이다.
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다(_model.ADD — 논리 ERD 에 없는 물리 칸).
ALTER TABLE "auth_sessions" ADD COLUMN "is_remembered" BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN "auth_sessions"."is_remembered" IS '자동 로그인 — 켜면 마지막 사용 후 30일, 끄면 7일 (2026-10-20) (물리에서 추가)';
