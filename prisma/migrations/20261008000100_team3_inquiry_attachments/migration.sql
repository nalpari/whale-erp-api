-- 3팀 문의 첨부파일 (2026-10-08 재영, 운영 정책 CNT-18).
--
-- 문의사항에 첨부파일을 붙인다. 이미지(JPG · PNG)와 PDF 만, 종류는 확장자가 아니라 파일 내용(매직 바이트)으로 앱이 확인해
-- file_type 에 넣는다. 문의 1건당 5개, 파일당 10MB. 등록할 때만 붙이고 뒤에 더하거나 빼지 않으며 답변에는 첨부가 없다 —
-- 그래서 is_deleted 를 두지 않는다(post_attachments 와 다른 점). 내려받기는 문의자 본인과 플랫폼 운영자만, 공개 주소로 두지 않는다.
-- 「문의당 5개」는 DB 가 막는다: 순서 1~5 CHECK 와 (inquiry_id, sort_order) 고유 — 6번째 행은 둘 중 하나에 걸린다.
--
-- 본문은 docs/raw/2026-10-06-3팀-schema.sql(물리 생성기 출력)에서 더해진 줄을 그대로 옮겼다.

CREATE TYPE "attachment_file_type" AS ENUM ('JPG', 'PNG', 'PDF');  -- JPG · PNG · PDF

-- 문의 첨부파일
CREATE TABLE "inquiry_attachments" (
    "inquiry_attachment_id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "inquiry_id" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" "attachment_file_type" NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,


    CONSTRAINT "inquiry_attachments_pkey" PRIMARY KEY ("inquiry_attachment_id")
);

ALTER TABLE "inquiry_attachments" ADD CONSTRAINT "inquiry_attachments_size_bytes_range" CHECK ("size_bytes" BETWEEN 1 AND 10485760);
ALTER TABLE "inquiry_attachments" ADD CONSTRAINT "inquiry_attachments_sort_order_range" CHECK ("sort_order" BETWEEN 1 AND 5);

CREATE UNIQUE INDEX "inquiry_attachments_inquiry_id_sort_order_key" ON "inquiry_attachments" ("inquiry_id", "sort_order");  -- 문의 하나에 순서 하나 — 순서 1~5 CHECK 와 함께 문의당 5개를 DB 가 막는다 (운영 정책 CNT-18)

ALTER TABLE "inquiry_attachments" ADD CONSTRAINT "inquiry_attachments_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries" ("inquiry_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON TABLE "inquiry_attachments" IS '문의 첨부파일';
COMMENT ON COLUMN "inquiry_attachments"."inquiry_attachment_id" IS '첨부파일 ID';
COMMENT ON COLUMN "inquiry_attachments"."inquiry_id" IS '문의사항 — 등록할 때만, 뒤에 더하거나 빼지 않음';
COMMENT ON COLUMN "inquiry_attachments"."file_name" IS '원래 파일 이름';
COMMENT ON COLUMN "inquiry_attachments"."file_type" IS '파일 종류 — JPG·PNG·PDF, 파일 내용으로 확인';
COMMENT ON COLUMN "inquiry_attachments"."size_bytes" IS '파일 크기 — 10MB 이하';
COMMENT ON COLUMN "inquiry_attachments"."storage_key" IS '저장 위치 — 공개 주소 아님';
COMMENT ON COLUMN "inquiry_attachments"."sort_order" IS '순서 — 1~5, 문의당 5개';
COMMENT ON COLUMN "inquiry_attachments"."created_at" IS '올린 시각';
