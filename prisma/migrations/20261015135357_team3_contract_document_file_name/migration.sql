-- 종이 계약 날인본 · 임금계약서 파일의 원래 이름 (2026-10-15).
-- 첨부 저장소 공지(2026-10-14, WHALEERP-587): 첨부 테이블에는 storage_key 와 원래 파일 이름만 남기고, 내려받으면 원래 이름으로 저장한다.
-- contract_documents 에는 이름 칸이 없었다. 아직 이 표에 쓰는 코드가 없어 행이 없으므로 NOT NULL 로 바로 더한다 —
-- 행이 있으면 실패하도록 먼저 확인한다(누가 손으로 넣은 행을 빈 이름으로 덮지 않게).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "contract_documents") THEN
    RAISE EXCEPTION 'contract_documents 에 행이 있다 — file_name 을 채울 방법을 정한 뒤 다시 적용한다';
  END IF;
END $$;

ALTER TABLE "contract_documents" ADD COLUMN "file_name" TEXT NOT NULL;
COMMENT ON COLUMN "contract_documents"."file_name" IS '원래 파일 이름 — 올린 파일의 원래 이름 — 내려받으면 이 이름으로 저장된다 (종이 계약 날인본, 2026-10-15) (물리에서 추가)';
