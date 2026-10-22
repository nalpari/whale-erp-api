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

-- 채운 입사일이 이미 잡힌 퇴직일보다 늦으면 실패한다 — 퇴직 처리 · 변경이 「퇴직일은 입사일보다 앞설 수 없다」로 막힌다.
-- 그동안 입사일이 늘 비어 이 검사가 걸린 적이 없다. 적용 전 공용 개발 DB 에서는 0건(2026-10-22)
DO $$
DECLARE
    inverted integer;
BEGIN
    SELECT count(*) INTO inverted
    FROM "staff_members"
    WHERE "hired_date" IS NOT NULL
      AND "retired_date" IS NOT NULL
      AND "retired_date" < "hired_date";
    IF inverted > 0 THEN
        RAISE EXCEPTION '퇴직일이 입사일보다 앞선 직원 레코드 %건 — 계약 시작일 · 퇴직일을 확인하세요', inverted;
    END IF;
END $$;
