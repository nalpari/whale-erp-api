-- WHALEERP-660 (2026-11-09 재영): 직원 가입 상태 「초대 발송」의 화면 이름을 「가입 대기」로 바꾼다(값 INVITED 는 그대로).
COMMENT ON TYPE "staff_member_join_status" IS '초안 · 가입 대기 · 가입 완료';
--
-- 칸 설명도 같이 바꾼다. 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다.
COMMENT ON COLUMN "staff_members"."join_status" IS '가입 상태 — 초안·가입 대기·가입 완료';
