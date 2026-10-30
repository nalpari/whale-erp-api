-- 3팀 최저임금 공통코드(WHALEERP-595) — 그룹 MINIMUM_WAGE 1개 · 상세 2개(2025 · 2026).
--
-- 근거: 2026-10-30 김민식 결정 — 최저임금은 별도 테이블 없이 공통코드로 관리한다. 근로계약 저장(POST · PUT /contracts)이
-- 수습 중 시급이 계약 시작일 최저임금의 90% 이상인지 이 값으로 보고, 관리자 웹 작성 화면도 같은 값을 받아 쓴다.
--
-- 값 형식(src/contracts/minimum-wage.ts 가 읽는다): 한 행이 한 시행일이다.
--   상세코드 = 'D' + 시행일 8자리(D20260101 = 2026-01-01부터). 상세코드는 영문으로 시작해야 해서(CHECK ^[A-Z][A-Z0-9_]{0,19}$) D 를 붙인다.
--   코드명   = 시급(원, 숫자만 — '10320'). 형식이 틀린 행은 api 가 빼고 경고를 남긴다.
-- 새 연도 값은 공통코드 관리 화면에서 상세를 하나 더 등록하면 된다(예 D20270101 · 그해 고시 금액).
--
-- 그룹은 3팀 다른 그룹처럼 플랫폼고정 · BP 미적용이다 — 원본 하나(BP000000)를 모든 BP 가 쓴다. 표시 순서는 지금 마지막 다음.
-- 초기값은 2025년 10,030원 · 2026년 10,320원 두 개다(2026-10-30 김민식 — 2025년도 넣는다). 그 전 연도는 넣지 않는다 —
-- api 는 2025-01-01(MINIMUM_WAGE_CHECKED_FROM) 전에 시작하는 계약을 보지 않고, 그 뒤인데 적용할 행이 없으면 400 이다.
-- 적용한 뒤에는 고치지 않는다 — 값을 바꿀 것은 새 마이그레이션이나 공통코드 관리 화면으로 한다.

INSERT INTO "code_groups" ("group_code", "group_name", "manage_owner_code", "is_bp_applied", "description", "status", "sort_order")
SELECT 'MINIMUM_WAGE', '최저임금', 'PLATFORM_FIXED', false,
       '상세코드 D+시행일 8자리(D20260101), 코드명 시급(원, 숫자만). 근로계약 수습 중 시급 확인에 쓴다', 'ACTIVE',
       COALESCE(MAX("sort_order"), 0) + 1
  FROM "code_groups";

INSERT INTO "code_items" ("group_code", "item_code", "bp_code", "label", "manage_owner_code", "status", "sort_order") VALUES
  ('MINIMUM_WAGE', 'D20250101', 'BP000000', '10030', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('MINIMUM_WAGE', 'D20260101', 'BP000000', '10320', 'PLATFORM_FIXED', 'ACTIVE', 2);

-- ── 건수 검사 ──
DO $$
BEGIN
  IF (SELECT count(*) FROM "code_groups" WHERE "group_code" = 'MINIMUM_WAGE') <> 1
     OR (SELECT string_agg("item_code" || '=' || "label", ',' ORDER BY "item_code") FROM "code_items"
          WHERE "group_code" = 'MINIMUM_WAGE' AND "bp_code" = 'BP000000') <> 'D20250101=10030,D20260101=10320' THEN
    RAISE EXCEPTION '최저임금 공통코드가 들어가지 않았다';
  END IF;
END $$;
