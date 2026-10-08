-- 근로계약서 「근무 장소」 칸 (2026-10-08). 계약서 근무 장소 조항에 들어가는 주소를 관리자가 직접 적는다(목업 contracts-new).
-- 근무지 점포(store_id)와는 따로다. 근로계약은 키만 NOT NULL 이라(KEYS_ONLY_NOT_NULL) 이 칸도 비울 수 있다.
ALTER TABLE "contracts" ADD COLUMN "work_location" TEXT;

COMMENT ON COLUMN "contracts"."work_location" IS '근무 장소 — 계약서 근무 장소 조항. 관리자가 직접 적는다 (목업 contracts-new, 2026-10-08) (물리에서 추가)';
