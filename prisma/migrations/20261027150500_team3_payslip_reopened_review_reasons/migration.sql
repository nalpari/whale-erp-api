-- 확정 취소한 명세서의 검토 사유를 다시 확인 전으로 돌린다(운영 정책 v221 PAY-06, 2026-10-27 재영 — 확정 취소하면 다시 검토 대기).
-- 사유에 확인 일시를 남기는 것은 확정뿐이라, 작성 중 · 검토 중 명세서에 남은 확인 표시는 모두 이 정책 전에 확정 취소한 명세서의 것이다.
-- 그 뒤의 확정 취소는 api 가 같은 트랜잭션에서 푼다.
UPDATE "payslip_review_reasons" r
SET "acknowledged_at" = NULL
FROM "payslips" p
WHERE r."payslip_id" = p."payslip_id"
  AND p."status" IN ('DRAFTING', 'REVIEWING')
  AND r."acknowledged_at" IS NOT NULL;
