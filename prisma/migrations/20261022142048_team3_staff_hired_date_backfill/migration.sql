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
  AND s."hired_date" IS NULL
  -- 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝난 근무이고, 채우면 퇴직일 < 입사일이 되어 퇴직일을
  -- 고칠 수 없다. 런타임(fillHiredDate)과 같은 규칙이다(api #124 code-review)
  AND (s."retired_date" IS NULL OR s."retired_date" >= f."start_date");

-- 퇴직일이 입사일보다 앞선 레코드가 남아 있으면 알린다(배포는 막지 않는다 — 위 UPDATE 는 만들지 않으므로 손으로 넣은
-- 입사일뿐이다). 그런 레코드는 퇴직 처리 · 변경이 「퇴직일은 입사일보다 앞설 수 없다」로 막힌다. 공용 개발 DB 0건(2026-10-22)
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
        RAISE NOTICE '퇴직일이 입사일보다 앞선 직원 레코드 %건 — 계약 시작일 · 퇴직일을 확인하세요', inverted;
    END IF;
END $$;
