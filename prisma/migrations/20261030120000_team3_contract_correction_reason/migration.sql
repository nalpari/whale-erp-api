-- 근로계약 수정 요청 사유를 남기고 거부 · 거절 사유 칸을 지운다(WHALEERP-635, 2026-10-30 김민식).
-- 직원 앱의 근로계약서 거절과 소속 추가 확인 · 복귀 확인 거절이 사유를 받지 않게 되어 reject_reason 두 칸은 쓰는 곳이 없다.
-- 이름만 바꾸면 옛 거부 사유가 수정 요청 사유로 남아 지우고 새로 만든다 — 기존 값은 옮기지 않는다.
-- 수정 요청 사유는 직원이 수정 요청 때 쓴 글(앞뒤 공백을 지운 1~100자) 그대로다. 다시 요청하면 덮어쓰고, 관리자가 고쳐 다시 보내도 지우지 않는다.
ALTER TABLE "contracts" DROP COLUMN "reject_reason";
ALTER TABLE "invitations" DROP COLUMN "reject_reason";
ALTER TABLE "contracts" ADD COLUMN "correction_reason" TEXT;

COMMENT ON COLUMN "contracts"."correction_reason" IS '수정 요청 사유 — 직원이 쓴 글, 100자';
