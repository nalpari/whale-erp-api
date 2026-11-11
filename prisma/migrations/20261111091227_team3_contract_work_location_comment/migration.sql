-- 근로계약 근무 장소(contracts.work_location) 설명 바로잡기 (2026-11-10, front #250 리뷰). 처음에는 「관리자가 직접 적는 주소,
-- 근무지와 따로」였지만, 관리자 웹이 소속 근무지를 고르면 근무지명으로 채우고 관리자가 고칠 수 있게 됐다. 비어 있으면 발송 ·
-- 날인 때 그때 점포명을 쓰는 것은 그대로다(contract-template.ts · contract-files.service.ts). 칸과 값은 그대로다.
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. 원본은 docs/erd-physical/_model.py 다.
COMMENT ON COLUMN "contracts"."work_location" IS '근무 장소 — 계약서 근무 장소 조항. 관리자 웹이 소속 근무지를 고르면 근무지명으로 채우고 관리자가 고칠 수 있다 — 비어 있으면 발송 · 날인 때 그때 점포명 (2026-11-10) (물리에서 추가)';
