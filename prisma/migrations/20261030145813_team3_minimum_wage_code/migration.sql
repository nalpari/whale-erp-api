-- 3팀 최저임금 공통코드(WHALEERP-595) — 그룹 MINIMUM_WAGE 1개 · 상세 HOURLY 1개.
--
-- 근거: 2026-10-30 김민식 결정 — 최저임금은 별도 테이블 없이 공통코드로 관리하고, 시행일마다 행을 늘리지 않고 코드 하나의
-- 값을 매년 고친다. 근로계약 저장(POST · PUT /contracts)이 수습 중 시급이 이 값의 90% 이상인지 보고(계약 시작일과 상관없이
-- 지금 값), 관리자 웹 작성 화면도 같은 값을 받아 쓴다.
--
-- 값 형식(src/contracts/minimum-wage.ts 가 읽는다): 상세코드 HOURLY 의 코드명 = 시급(원, 숫자만 — '10320').
-- 최저임금이 바뀌면 공통코드 관리 화면에서 이 코드명을 고친다(고시 뒤 1월 1일 전). 코드가 없거나 · 사용 중지됐거나 ·
-- 코드명이 숫자가 아니면 수습이 있는 계약 저장이 그 까닭으로 400 이다 — 검사가 조용히 꺼지지 않게.
--
-- 그룹은 3팀 다른 그룹처럼 플랫폼고정 · BP 미적용이다 — 원본 하나(BP000000)를 모든 BP 가 쓴다. 표시 순서는 지금 마지막 다음.
-- 초기값은 2026년 최저임금 10,320원이다.
-- 적용한 뒤에는 고치지 않는다 — 값은 공통코드 관리 화면에서 고친다.

INSERT INTO "code_groups" ("group_code", "group_name", "manage_owner_code", "is_bp_applied", "description", "status", "sort_order")
SELECT 'MINIMUM_WAGE', '최저임금', 'PLATFORM_FIXED', false,
       '상세 HOURLY 의 코드명이 시급(원, 숫자만). 매년 고친다. 근로계약 수습 중 시급 확인에 쓴다', 'ACTIVE',
       COALESCE(MAX("sort_order"), 0) + 1
  FROM "code_groups";

INSERT INTO "code_items" ("group_code", "item_code", "bp_code", "label", "manage_owner_code", "status", "sort_order") VALUES
  ('MINIMUM_WAGE', 'HOURLY', 'BP000000', '10320', 'PLATFORM_FIXED', 'ACTIVE', 1);

-- ── 건수 검사 ──
DO $$
BEGIN
  IF (SELECT count(*) FROM "code_groups" WHERE "group_code" = 'MINIMUM_WAGE') <> 1
     OR (SELECT string_agg("item_code" || '=' || "label", ',' ORDER BY "item_code") FROM "code_items"
          WHERE "group_code" = 'MINIMUM_WAGE' AND "bp_code" = 'BP000000') IS DISTINCT FROM 'HOURLY=10320' THEN
    RAISE EXCEPTION '최저임금 공통코드가 들어가지 않았다';
  END IF;
END $$;
