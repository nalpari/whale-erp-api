-- 직원 입사일 채우기 (WHALEERP-613, 완료 조건 3). 입사일은 그 점포에서 처음 체결 완료된 근로계약의 시작일이고, 갱신 계약이
-- 와도 바꾸지 않는다(2026-10-21 재영). 이제부터는 체결 완료(직원 날인 · 종이 계약 등록)가 빈 입사일을 채우지만, 그 전에 체결
-- 완료된 직원은 비어 있어 한 번 채운다 — 직원 레코드는 점포마다 하나라, 레코드마다 체결 완료 이력이 가장 앞선 계약의 시작일이다.
-- 이미 입사일이 있는 레코드는 그대로 둔다. 체결 완료는 시작일이 필수라(임시저장만 비울 수 있다) 시작일이 빈 계약은 없다.
UPDATE "staff_members" s
SET "hired_date" = f."start_date"
FROM (
    SELECT DISTINCT ON (c."staff_member_id") c."staff_member_id", c."start_date"
    FROM "contracts" c
    JOIN "contract_status_histories" h ON h."contract_id" = c."contract_id" AND h."to_status" = 'SIGNED'
    WHERE c."start_date" IS NOT NULL
    ORDER BY c."staff_member_id", h."changed_at", h."contract_status_history_id"
) f
WHERE s."staff_member_id" = f."staff_member_id"
  AND s."hired_date" IS NULL;

-- 체결 완료 이력이 있는데 입사일이 빈 레코드가 남으면 실패한다
DO $$
DECLARE
    missing integer;
BEGIN
    SELECT count(*) INTO missing
    FROM "staff_members" s
    WHERE s."hired_date" IS NULL
      AND EXISTS (
          SELECT 1
          FROM "contracts" c
          JOIN "contract_status_histories" h ON h."contract_id" = c."contract_id" AND h."to_status" = 'SIGNED'
          WHERE c."staff_member_id" = s."staff_member_id" AND c."start_date" IS NOT NULL
      );
    IF missing > 0 THEN
        RAISE EXCEPTION '입사일이 빈 체결 완료 직원 레코드 %건', missing;
    END IF;
END $$;
