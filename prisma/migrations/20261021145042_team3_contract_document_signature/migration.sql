-- 근로계약 문서 종류 「서명 이미지」(WHALEERP-145, 2026-10-21 김민식 결정).
-- 직원 앱 날인 때 받는 필기 서명 PNG 를 계약서와 같은 저장소 · 같은 보존 기간으로 둔다(contract_documents 한 행).
-- 처리 완료본(서명을 합성한 PDF, 날인 완료본)은 WHALEERP-131 이 만든다.

-- AlterEnum — 끝자리. 이름 순서가 화면 순서다(GET /enums).
ALTER TYPE "contract_document_kind" ADD VALUE 'SIGNATURE';
COMMENT ON TYPE "contract_document_kind" IS '발송 원본 · 날인 완료본 · 종이 계약 근로계약서 · 임금계약서 · 서명 이미지';
