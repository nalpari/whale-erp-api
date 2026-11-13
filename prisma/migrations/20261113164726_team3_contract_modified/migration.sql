-- 근로계약 상세의 「최종수정」 — 관리자가 마지막으로 고치거나 보낸 때와 그 관리자를 남긴다 (WHALEERP-699, 2026-11-13 김민식).
-- updated_at(@updatedAt)은 직원 서명 · 거절 · 소속 확인 응답과 만료 · 종료 · 갱신 알림 배치에도 바뀌어 쓸 수 없다.
-- 이 두 칸은 관리자 웹의 등록 · 저장 · 근로자 정보 수정 · 발송 · 재발송 · 발송 대기 종료에서만 채운다.
-- 기존 행은 등록한 때 · 등록한 관리자로 채운다(그 뒤 관리자 수정 기록이 없어서 등록을 마지막 관리자 수정으로 본다).
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. front 논리 ERD 카탈로그에는 없는 물리 추가 칸이다.
ALTER TABLE "contracts" ADD COLUMN "modified_at" TIMESTAMPTZ(6);
ALTER TABLE "contracts" ADD COLUMN "modified_by" INTEGER;

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_modified_by_fkey" FOREIGN KEY ("modified_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

UPDATE "contracts" SET "modified_at" = "created_at", "modified_by" = "created_by";

COMMENT ON COLUMN "contracts"."modified_at" IS '최종수정 일시 — 관리자가 고치거나 보낸 때만 (직원 서명 · 배치는 바꾸지 않는다) (WHALEERP-699, 2026-11-13) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."modified_by" IS '최종수정 관리자 — 관리자가 고치거나 보낸 때만 (직원 서명 · 배치는 바꾸지 않는다) (WHALEERP-699, 2026-11-13) (물리에서 추가)';
