-- 근로계약 수정 요청 사유를 남기고 거부 · 거절 사유 칸을 지운다(WHALEERP-635, 2026-10-30 김민식).
-- 직원 앱의 근로계약서 거절과 소속 추가 확인 · 복귀 확인 거절이 사유를 받지 않게 되어 reject_reason 두 칸은 쓰는 곳이 없다.
-- 이름만 바꾸면 옛 거부 사유가 수정 요청 사유로 남아 지우고 새로 만든다 — 기존 값은 옮기지 않는다.
-- 수정 요청 사유는 직원이 수정 요청 때 쓴 글(앞뒤 공백을 지운 1~100자) 그대로다. 다시 요청하면 덮어쓰고, 관리자가 고쳐 다시 보내도 지우지 않는다.
--
-- 배포: Prisma 는 select 없는 조회 · 쓰기에 칸 이름을 모두 나열한다. 이 파일을 적용한 뒤 옛 코드가 돌면 reject_reason 을, 적용하기
-- 전에 새 코드가 돌면 correction_reason 을 찾다가 contracts · invitations 를 읽고 쓰는 요청이 500(42703)이 된다. db:deploy 직후
-- 바로 새 컨테이너로 바꾸고, 같은 DB 를 쓰는 다른 로컬 api 는 main 을 받아 prisma generate 를 다시 한다.
ALTER TABLE "contracts" DROP COLUMN "reject_reason";
ALTER TABLE "invitations" DROP COLUMN "reject_reason";
ALTER TABLE "contracts" ADD COLUMN "correction_reason" TEXT;

COMMENT ON COLUMN "contracts"."correction_reason" IS '수정 요청 사유 — 직원이 쓴 글, 100자';
