-- 메일 발송 이력(mail_send_logs, 1팀 테이블)을 직원에게 보낸 메일까지 담게 고친다(WHALEERP-676, 2026-11-13 노영주 결정 · 1팀 협의).
-- 직원 상세 발송 이력에 비밀번호 초기화 메일을 싣는다. 새 테이블은 만들지 않는다.
--
-- 1) admin_account_id → account_id. 관리자에게 보낸 메일이면 관리자 계정 id(admin_accounts), 직원에게 보낸 메일이면 직원 계정
--    id(accounts.account_id)를 담는다 — 어느 쪽인지는 mail_type_code 로 가른다. 두 테이블을 함께 가리키므로 FK 는 없앤다.
--    기존 값은 모두 관리자 계정 id 이고 RENAME 이라 그대로 남는다.
-- 2) staff_member_id 를 더한다. 직원 레코드는 계약 정리(contract-duplicates · contracts.service)에서 지워질 수 있어
--    ON DELETE SET NULL — 이력은 남고 직원 칸만 비워진다. 이미 쌓인 행은 직원을 알 수 없어 NULL 로 시작한다.
-- sent_by 의 FK 는 그대로다.

-- RenameColumn · DropForeignKey · RenameIndex
ALTER TABLE "mail_send_logs" DROP CONSTRAINT "mail_send_logs_admin_account_id_fkey";
ALTER TABLE "mail_send_logs" RENAME COLUMN "admin_account_id" TO "account_id";
ALTER INDEX "mail_send_logs_admin_account_id_sent_at_idx" RENAME TO "mail_send_logs_account_id_sent_at_idx";

COMMENT ON COLUMN "mail_send_logs"."account_id" IS '수신 계정 — 관리자에게 보낸 메일이면 admin_accounts.admin_account_id, 직원에게 보낸 메일(비밀번호 초기화)이면 accounts.account_id. 어느 쪽인지는 메일 유형 코드(mail_type_code)로 가른다. FK 없음 (WHALEERP-676, 2026-11-13 1팀 협의)';

-- AlterTable
ALTER TABLE "mail_send_logs" ADD COLUMN "staff_member_id" INTEGER;

COMMENT ON COLUMN "mail_send_logs"."staff_member_id" IS '수신 직원 — 직원에게 보낸 메일일 때 staff_members FK. 직원 상세 발송 이력이 읽는다. 직원 레코드가 지워지면 비움 (WHALEERP-676, 2026-11-13) (3팀 추가)';

-- AddForeignKey
ALTER TABLE "mail_send_logs" ADD CONSTRAINT "mail_send_logs_staff_member_id_fkey" FOREIGN KEY ("staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- CreateIndex
CREATE INDEX "mail_send_logs_staff_member_id_sent_at_idx" ON "mail_send_logs" ("staff_member_id", "sent_at");
