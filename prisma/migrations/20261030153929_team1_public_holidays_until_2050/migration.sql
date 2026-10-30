-- 공식 휴일을 2000~2050 으로 줄이고, 규칙 계산 행의 이름을 공공 API(특일 정보) 표기로 맞춘다(2026-10-30 재영 결정).
--
-- ── 1. 2051~2100 을 지운다 ──
--   음력 변환표(한국천문연구원)가 2050년까지라 2051~2100 은 양력만 들어 있었다(487행). 「모자란 음력분은 공공 API
--   동기화로」 받기로 했지만 동기화는 올해 · 다음 해만 받으므로 그 해들의 설날 · 부처님오신날 · 추석은 비어 있었다.
--   빈 연도 없는 2000~2050 으로 범위를 줄인다. 이 표는 논리 삭제 칸이 없고(동기화도 API 에 없는 날을 지운다),
--   이 행을 가리키는 외래키도 없어 DELETE 한다. CHECK 도 같은 범위로 다시 건다.
--
-- ── 2. 규칙 계산(RULE) 행의 이름 ──
--   동기화한 해는 API 원문 이름에 비고가 없고(「1월1일」 · 「기독탄신일」 · 「대체공휴일(삼일절)」), 계산한 해는
--   「신정」 · 「성탄절」 · 「삼일절」 + 비고 「대체공휴일 — 삼일절」이라 해를 넘기면 이름이 바뀌었다. 2026년 동기화 행으로
--   확인한 API 표기에 맞춘다:
--     신정 → 1월1일, 성탄절 → 기독탄신일, 설날 연휴 → 설날, 추석 연휴 → 추석(API 는 사흘 모두 「설날」 · 「추석」)
--     대체공휴일: 이름 「대체공휴일(본 휴일)」, 비고 NULL — 비고가 「대체공휴일 — 본 휴일」인 행이다.
--   나머지(삼일절 · 어린이날 · 부처님오신날 · 현충일 · 광복절 · 개천절 · 한글날 · 식목일 · 제헌절)는 그대로다. 두 휴일이
--   겹친 날의 「 · 」 묶음은 안의 이름만 바뀐다. 동기화(PUBLIC_API) 행은 건드리지 않는다.
--   설날 · 추석 대체공휴일과 기독탄신일 대체공휴일의 API 표기는 2026년 행에 없어 같은 꼴로 미루어 정했다.

DELETE FROM "public_holidays" WHERE "year" > 2050;

ALTER TABLE "public_holidays" DROP CONSTRAINT "public_holidays_year_range";
ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_year_range" CHECK ("year" BETWEEN 2000 AND 2050);
COMMENT ON COLUMN "public_holidays"."year" IS '연도 — 2000~2050';

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
  SELECT count(*) INTO n FROM "public_holidays" WHERE "year" > 2050;
  IF n <> 0 THEN RAISE EXCEPTION '2050년 뒤 공식 휴일이 %행 남았다', n; END IF;

  SELECT count(*) INTO n FROM "public_holidays" WHERE "source" = 'RULE' AND "note" IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION '비고가 남은 규칙 계산 행이 %행이다', n; END IF;

  SELECT count(*) INTO n FROM "public_holidays"
   WHERE "source" = 'RULE' AND ("name" LIKE '%신정%' OR "name" LIKE '%성탄절%' OR "name" LIKE '%연휴%' OR "name" LIKE '%—%');
  IF n <> 0 THEN RAISE EXCEPTION '옛 이름이 남은 규칙 계산 행이 %행이다', n; END IF;

  -- 실제 달력과 대조한 표본(RULE 로 남아 있을 때만 — 동기화가 덮은 해는 API 값이다)
  IF EXISTS (SELECT 1 FROM "public_holidays"
              WHERE "holiday_date" = DATE '2024-02-12' AND "source" = 'RULE' AND "name" <> '대체공휴일(설날)')
    THEN RAISE EXCEPTION '2024-02-12 이 대체공휴일(설날)이 아니다'; END IF;
  IF EXISTS (SELECT 1 FROM "public_holidays"
              WHERE "holiday_date" = DATE '2025-12-25' AND "source" = 'RULE' AND "name" <> '기독탄신일')
    THEN RAISE EXCEPTION '2025-12-25 가 기독탄신일이 아니다'; END IF;
END $$;
