-- 도입문의 답변 메일 다시 보내기 (WHALEERP-597, 2026-10-19 재영 결정).
-- 마지막 답변 메일의 결과 · 시각을 도입문의 행에 둔다. mail_send_logs 에는 어느 도입문의의 메일인지 가리키는 칸이 없어
-- 같은 이메일로 접수된 다른 도입문의 메일과 섞이고, 그 테이블(1팀)은 건드리지 않기로 했다.
-- 첫 답변 메일과 다시 보내기가 모두 이 두 칸을 고친다. 다시 보내기는 같은 도입문의에 1분 간격이고, 그 기준이 시각 칸이다.
-- 이미 답변한 도입문의는 보낸 기록이 없어 두 칸 모두 NULL 로 시작한다.

-- CreateEnum
CREATE TYPE "reply_mail_result" AS ENUM ('SUCCEEDED', 'FAILED');
COMMENT ON TYPE "reply_mail_result" IS '성공 · 실패';

-- AlterTable
ALTER TABLE "leads"
    ADD COLUMN "reply_mail_result" "reply_mail_result",
    ADD COLUMN "reply_mail_attempted_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN "leads"."reply_mail_result" IS '답변 메일 결과 — 마지막 답변 메일의 결과 — 보낸 적 없거나 결과를 아직 모르면(보내는 중) NULL (WHALEERP-597, 2026-10-19 재영) (물리에서 추가)';
COMMENT ON COLUMN "leads"."reply_mail_attempted_at" IS '답변 메일 시각 — 마지막으로 답변 메일을 보내려 한 시각 — 다시 보내기 1분 간격의 기준 (WHALEERP-597, 2026-10-19 재영) (물리에서 추가)';
