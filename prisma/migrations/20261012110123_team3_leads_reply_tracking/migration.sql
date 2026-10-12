-- 도입문의 답변 추적 칸 (2026-10-12 재영 승인, Plane #274).
-- 누가 언제 답변했는지(replied_by · replied_at)와, 두 관리자가 같은 문의를 동시에 저장할 때 충돌을 가르는 updated_at 을 더한다.
-- 기존 행은 replied_by · replied_at 이 비고, updated_at 은 기본값(적용 시각)으로 채워진다.
-- 물리 결정은 docs/erd-physical/_model.py 의 ADD.
ALTER TABLE "leads" ADD COLUMN "replied_by" INTEGER;
ALTER TABLE "leads" ADD COLUMN "replied_at" TIMESTAMPTZ(6);
ALTER TABLE "leads" ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "leads" ADD CONSTRAINT "leads_replied_by_fkey" FOREIGN KEY ("replied_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON COLUMN "leads"."replied_by" IS '답변 관리자 — 답변을 저장한 관리자 (2026-10-12 재영, Plane #274) (물리에서 추가)';
COMMENT ON COLUMN "leads"."replied_at" IS '답변 일시 — 답변을 저장한 시각 (2026-10-12 재영, Plane #274) (물리에서 추가)';
COMMENT ON COLUMN "leads"."updated_at" IS '최근 수정 일시 — 동시 저장 충돌 판정 (2026-10-12 재영, Plane #274) (물리에서 추가)';
