-- 문의사항 · 도입문의 처리 시작 칸 (2026-10-13, Plane #274).
-- 운영자가 답변 상태를 처리중으로 바꿀 때 누가(processing_started_by) 언제(processing_started_at) 바꿨는지 남긴다.
-- 처리중을 거치지 않고 바로 답변하면 둘 다 NULL 이다. 기존 행도 둘 다 비어 있다 — 이미 처리중인 행이 있어도 적용이 막히지 않도록,
-- 「처리중이면 값이 있다」는 걸지 않고 「둘은 함께 채우거나 함께 비운다」만 건다.
-- 물리 결정은 docs/erd-physical/_model.py 의 ADD · CHECKS.
ALTER TABLE "inquiries"
    ADD COLUMN "processing_started_by" INTEGER,
    ADD COLUMN "processing_started_at" TIMESTAMPTZ(6);
ALTER TABLE "leads"
    ADD COLUMN "processing_started_by" INTEGER,
    ADD COLUMN "processing_started_at" TIMESTAMPTZ(6);

ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_processing_started_pair" CHECK (("processing_started_by" IS NULL) = ("processing_started_at" IS NULL));
ALTER TABLE "leads" ADD CONSTRAINT "leads_processing_started_pair" CHECK (("processing_started_by" IS NULL) = ("processing_started_at" IS NULL));

ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_processing_started_by_fkey" FOREIGN KEY ("processing_started_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "leads" ADD CONSTRAINT "leads_processing_started_by_fkey" FOREIGN KEY ("processing_started_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON COLUMN "inquiries"."processing_started_by" IS '처리 시작 관리자 — 처리중으로 바꾼 관리자 (2026-10-13, Plane #274). 처리중을 거치지 않고 답변하면 NULL (물리에서 추가)';
COMMENT ON COLUMN "inquiries"."processing_started_at" IS '처리 시작 일시 — 처리중으로 바꾼 시각 (2026-10-13, Plane #274). 처리중을 거치지 않고 답변하면 NULL (물리에서 추가)';
COMMENT ON COLUMN "leads"."processing_started_by" IS '처리 시작 관리자 — 처리중으로 바꾼 관리자 (2026-10-13, Plane #274). 처리중을 거치지 않고 답변하면 NULL (물리에서 추가)';
COMMENT ON COLUMN "leads"."processing_started_at" IS '처리 시작 일시 — 처리중으로 바꾼 시각 (2026-10-13, Plane #274). 처리중을 거치지 않고 답변하면 NULL (물리에서 추가)';
