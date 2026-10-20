-- 공지사항 첨부파일 (WHALEERP-272, 2026-10-19 재영 결정 · 운영 정책 CNT-18 v144).
--
-- 공지 첨부는 문의 첨부와 같다 — 이미지(JPG · PNG)와 PDF 만, 종류는 확장자가 아니라 파일 내용으로 앱이 확인해 file_type 에
-- 넣는다. 공지 1건당 5개, 파일당 10MB. FAQ 는 첨부를 받지 않는다(앱이 막는다). 종류 enum 은 문의 첨부의 것을 다시 쓴다.
--
-- 「공지당 5개」는 DB 도 막는다: 자리(sort_order) 1~5 CHECK 와, 지우지 않은 첨부끼리의 (post_id, sort_order) 고유.
-- 문의 첨부와 달리 공지 첨부는 수정에서 뺄 수 있고 뺀 행은 지움 표시(is_deleted)로 남으므로 고유에 조건을 붙인다.
-- 자리는 개수를 세는 칸이라 기본값 0 을 없앤다 — 앱이 빈 자리를 골라 넣는다. 화면 순서는 올린 순서(post_attachment_id)다.
--
-- 지금까지 공지 첨부를 만드는 API 가 없어(api #18 에서 미룸) 행이 없어야 한다. 있으면 file_type 을 채울 수 없으므로 멈춘다.
--
-- 본문은 docs/raw/2026-10-06-3팀-schema.sql(물리 생성기 출력)에서 바뀐 줄을 옮겼다.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "post_attachments") THEN
        RAISE EXCEPTION 'post_attachments 에 행이 있어 file_type(NOT NULL)을 더할 수 없습니다 — 기존 행의 종류를 먼저 정하세요';
    END IF;
END $$;

-- AlterTable
ALTER TABLE "post_attachments"
    ADD COLUMN "file_type" "attachment_file_type" NOT NULL,
    ALTER COLUMN "sort_order" DROP DEFAULT;

ALTER TABLE "post_attachments" ADD CONSTRAINT "post_attachments_sort_order_range" CHECK ("sort_order" BETWEEN 1 AND 5);

CREATE UNIQUE INDEX "post_attachments_post_id_sort_order_key" ON "post_attachments" ("post_id", "sort_order") WHERE "is_deleted" = false;  -- 공지 하나에 지우지 않은 첨부의 자리 하나 — 자리 1~5 CHECK 와 함께 공지당 5개를 DB 가 막는다 (WHALEERP-272)

COMMENT ON COLUMN "post_attachments"."file_type" IS '파일 종류 — JPG·PNG·PDF, 파일 내용으로 확인 (WHALEERP-272, 운영 정책 CNT-18 v144) (물리에서 추가)';
COMMENT ON COLUMN "post_attachments"."storage_key" IS '저장 위치 — 공개 주소 아님 — 저장소 키(posts/{post_id}/…) (WHALEERP-272)';
COMMENT ON COLUMN "post_attachments"."sort_order" IS '순서 — 자리 1~5 — 지우지 않은 첨부끼리 겹치지 않아 공지당 5개. 보이는 순서는 올린 순서 (WHALEERP-272)';
