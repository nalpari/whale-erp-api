-- 규칙 계산(RULE) 공식 휴일의 이름을 공공 API(특일 정보) 표기로 맞춘다(2026-10-30 재영 결정).
--
-- 동기화한 해는 API 원문 이름에 비고가 없고(「1월1일」 · 「기독탄신일」 · 「대체공휴일(삼일절)」), 계산한 해는
-- 「신정」 · 「성탄절」 · 「삼일절」 + 비고 「대체공휴일 — 삼일절」이라 해를 넘기면 이름이 바뀌었고, 캘린더(이름만 보임)에서는
-- 대체공휴일인지 보이지 않았다. 2026년 동기화 행으로 확인한 API 표기에 맞춘다:
--   신정 → 1월1일, 성탄절 → 기독탄신일, 설날 연휴 → 설날, 추석 연휴 → 추석(API 는 사흘 모두 「설날」 · 「추석」)
--   대체공휴일: 이름 「대체공휴일(본 휴일)」, 비고 NULL — 비고가 「대체공휴일 — 본 휴일」인 행이다.
-- 나머지(삼일절 · 어린이날 · 부처님오신날 · 현충일 · 광복절 · 개천절 · 한글날 · 식목일 · 제헌절)는 그대로다. 두 휴일이
-- 겹친 날의 「 · 」 묶음은 안의 이름만 바뀐다. 동기화(PUBLIC_API) 행은 건드리지 않는다. 설날 · 추석 · 기독탄신일
-- 대체공휴일의 API 표기는 2026년 행에 없어 같은 꼴로 미루어 정했다.
--
-- 대상은 RULE 행 전체(2000~2100)다. 2051~2100 은 음력 변환표(한국천문연구원)가 2050년까지라 음력 공휴일(설날 ·
-- 부처님오신날 · 추석) 없이 양력만 있다. 그 행은 남기고 화면 · 조회도 막지 않는다(재영) — 그 양력분도 같은 표기로
-- 맞춰 해를 넘겨 이름이 바뀌지 않게 한다.

-- 바꾸기 전 대체공휴일(비고가 있는 RULE 행)을 적어 두고, 바꾼 뒤 그 행이 모두 「대체공휴일(…)」인지 센다.
CREATE TEMP TABLE "rule_substitutes" AS
  SELECT "public_holiday_id" FROM "public_holidays" WHERE "source" = 'RULE' AND "note" IS NOT NULL;

UPDATE "public_holidays"
SET
  "name" = CASE
    WHEN "note" IS NULL THEN api_name
    ELSE '대체공휴일(' || api_name || ')'
  END,
  "note" = NULL
FROM (
  SELECT
    "public_holiday_id" AS id,
    replace(replace(replace(replace("name",
      '설날 연휴', '설날'),
      '추석 연휴', '추석'),
      '신정', '1월1일'),
      '성탄절', '기독탄신일') AS api_name
  FROM "public_holidays"
  WHERE "source" = 'RULE'
) AS mapped
WHERE "public_holidays"."public_holiday_id" = mapped.id;

-- ── 검사 ──
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM "public_holidays" WHERE "source" = 'RULE' AND "note" IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION '비고가 남은 규칙 계산 행이 %행이다', n; END IF;

  SELECT count(*) INTO n FROM "public_holidays"
   WHERE "source" = 'RULE' AND ("name" LIKE '%신정%' OR "name" LIKE '%성탄절%' OR "name" LIKE '%연휴%' OR "name" LIKE '%—%');
  IF n <> 0 THEN RAISE EXCEPTION '옛 이름이 남은 규칙 계산 행이 %행이다', n; END IF;

  -- 적어 둔 대체공휴일이 하나도 빠지지 않고 「대체공휴일(…)」이 됐다(공용 DB 는 동기화한 해만큼 189 보다 적다)
  SELECT count(*) INTO n FROM "rule_substitutes";
  IF n = 0 THEN RAISE EXCEPTION '바꿀 대체공휴일 행이 없다 — 공식 휴일 데이터가 비었다'; END IF;
  SELECT count(*) INTO n FROM "rule_substitutes" s
    JOIN "public_holidays" h USING ("public_holiday_id")
   WHERE h."name" NOT LIKE '대체공휴일(%)';
  IF n <> 0 THEN RAISE EXCEPTION '「대체공휴일(…)」로 바뀌지 않은 대체공휴일이 %행이다', n; END IF;

  -- 실제 달력과 대조한 표본 — 그 행이 그 이름으로 있어야 한다(2024 · 2025 · 2100 은 동기화 대상이 아니라 RULE 그대로다)
  IF NOT EXISTS (SELECT 1 FROM "public_holidays" WHERE "holiday_date" = DATE '2024-02-12' AND "name" = '대체공휴일(설날)')
    THEN RAISE EXCEPTION '2024-02-12 대체공휴일(설날)이 없다'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "public_holidays" WHERE "holiday_date" = DATE '2024-09-17' AND "name" = '추석')
    THEN RAISE EXCEPTION '2024-09-17 추석이 없다'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "public_holidays" WHERE "holiday_date" = DATE '2025-12-25' AND "name" = '기독탄신일')
    THEN RAISE EXCEPTION '2025-12-25 기독탄신일이 없다'; END IF;
  -- 2051~2100 양력분도 같은 표기로 남는다
  IF NOT EXISTS (SELECT 1 FROM "public_holidays" WHERE "holiday_date" = DATE '2100-12-25' AND "name" = '기독탄신일')
    THEN RAISE EXCEPTION '2100-12-25 기독탄신일이 없다'; END IF;
END $$;

DROP TABLE "rule_substitutes";
