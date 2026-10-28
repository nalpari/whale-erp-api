-- 계약마다 직무를 남긴다(WHALEERP-156, 2026-10-27 김민식). 지금까지는 직원 레코드에만 있어 재계약을 저장만 해도(임시저장 · 발송)
-- 재직 중인 직원의 직무가 새 계약 값으로 바뀌고, 재계약이 거부 · 만료돼도 되돌아가지 않았다. 계약이 시작하면 직원 레코드로 옮긴다.
ALTER TABLE "contracts" ADD COLUMN "job_title" TEXT;

-- 있던 계약은 그 직원 레코드의 직무로 채운다 — 재계약 전이라 계약과 직원 레코드의 직무가 같았다
UPDATE "contracts" c SET "job_title" = s."job_title" FROM "staff_members" s WHERE s."staff_member_id" = c."staff_member_id";

COMMENT ON COLUMN "contracts"."job_title" IS '직무 — 계약서에 적은 직무 — 그 계약이 시작하면 직원 레코드의 직무로 옮긴다(재계약을 저장만 해도 바뀌지 않게) (WHALEERP-156, 2026-10-27 김민식) (물리에서 추가)';
