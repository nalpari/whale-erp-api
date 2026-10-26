-- BP 휴일 대상 점포 · 예외 점포를 기간으로 바꾼다 (BP 휴일 변경 · 종료 정책, 2026-10-26 1팀).
--
-- 휴일에 영향을 주는 변경은 앞으로의 날짜에만 적용한다. 점포를 더하면 그 점포는 오늘부터, 빼면 어제까지다 —
-- 지난 날짜에 어느 점포가 쉬었는지는 바뀌지 않는다. 그래서 두 표 모두 한 행이 한 기간이다:
--   holiday_store_mappings  (특정 점포 휴일의 대상 점포) — 적용 시작일을 더한다(종료일은 있었다).
--   holiday_excluded_stores (전체 점포 휴일의 예외 점포) — 적용 종료일을 더한다(시작일은 있었다).
-- 같은 점포를 뺐다가 다시 더하면 새 기간(새 행)이다. 기본키가 (휴일, 점포)면 한 점포에 행이 하나뿐이라 덮어써야
-- 하므로, 행마다 ID 를 두는 기본키로 바꾼다. 대신 열린 기간(종료일 없음)은 휴일 · 점포마다 하나만 둔다 — 같은
-- 점포를 동시에 두 번 더하는 요청이 둘 다 들어가지 않게 하는 것은 이 부분 고유 인덱스다.
--
-- is_deleted 는 「한 번도 적용되지 않은 기간」이다(오늘 더하고 오늘 뺀 점포, 시작 전 휴일에서 뺀 점포). 적용된
-- 날이 있는 기간은 지우지 않고 종료일만 넣는다. 읽는 쪽은 다른 표처럼 is_deleted = false 만 본다.
--
-- 기존 행: 대상 점포의 시작일은 휴일 시작일로 채운다(처음부터 묶여 있던 점포다). 예외 점포의 종료일은 비운다.

-- 휴일 점포 매핑 ─────────────────────────────────────────────
ALTER TABLE "holiday_store_mappings" ADD COLUMN "effective_start_date" DATE;
UPDATE "holiday_store_mappings" m
   SET "effective_start_date" = h."start_date"
  FROM "bp_holidays" h
 WHERE h."bp_holiday_id" = m."bp_holiday_id";
ALTER TABLE "holiday_store_mappings" ALTER COLUMN "effective_start_date" SET NOT NULL;

ALTER TABLE "holiday_store_mappings" DROP CONSTRAINT "holiday_store_mappings_pkey";
ALTER TABLE "holiday_store_mappings"
  ADD COLUMN "holiday_store_mapping_id" INTEGER GENERATED ALWAYS AS IDENTITY;
ALTER TABLE "holiday_store_mappings"
  ADD CONSTRAINT "holiday_store_mappings_pkey" PRIMARY KEY ("holiday_store_mapping_id");

ALTER TABLE "holiday_store_mappings" ADD CONSTRAINT "holiday_store_mappings_effective_end_after_start"
  CHECK ("effective_end_date" >= "effective_start_date");
CREATE INDEX "holiday_store_mappings_bp_holiday_id_idx" ON "holiday_store_mappings" ("bp_holiday_id");
CREATE UNIQUE INDEX "holiday_store_mappings_bp_holiday_id_store_id_open_key"
  ON "holiday_store_mappings" ("bp_holiday_id", "store_id")
  WHERE NOT "is_deleted" AND "effective_end_date" IS NULL;

COMMENT ON COLUMN "holiday_store_mappings"."holiday_store_mapping_id" IS '휴일 점포 매핑 ID — 한 행이 한 적용 기간';
COMMENT ON COLUMN "holiday_store_mappings"."effective_start_date" IS '적용 시작일 — 점포를 더한 날(시작 전 휴일이면 휴일 시작일)';
COMMENT ON COLUMN "holiday_store_mappings"."effective_end_date" IS '적용 종료일 — 점포를 뺀 날의 전날. 비어 있으면 휴일이 끝날 때까지';
COMMENT ON COLUMN "holiday_store_mappings"."is_deleted" IS '삭제 여부 — 적용된 날이 없는 기간(오늘 더하고 오늘 뺌 · 시작 전 휴일에서 뺌)';

-- 휴일 예외 점포 ─────────────────────────────────────────────
ALTER TABLE "holiday_excluded_stores" ADD COLUMN "effective_end_date" DATE;

ALTER TABLE "holiday_excluded_stores" DROP CONSTRAINT "holiday_excluded_stores_pkey";
ALTER TABLE "holiday_excluded_stores"
  ADD COLUMN "holiday_excluded_store_id" INTEGER GENERATED ALWAYS AS IDENTITY;
ALTER TABLE "holiday_excluded_stores"
  ADD CONSTRAINT "holiday_excluded_stores_pkey" PRIMARY KEY ("holiday_excluded_store_id");

ALTER TABLE "holiday_excluded_stores" ADD CONSTRAINT "holiday_excluded_stores_effective_end_after_start"
  CHECK ("effective_end_date" >= "effective_start_date");
CREATE INDEX "holiday_excluded_stores_bp_holiday_id_idx" ON "holiday_excluded_stores" ("bp_holiday_id");
CREATE UNIQUE INDEX "holiday_excluded_stores_bp_holiday_id_store_id_open_key"
  ON "holiday_excluded_stores" ("bp_holiday_id", "store_id")
  WHERE NOT "is_deleted" AND "effective_end_date" IS NULL;

COMMENT ON COLUMN "holiday_excluded_stores"."holiday_excluded_store_id" IS '휴일 예외 점포 ID — 한 행이 한 예외 기간';
COMMENT ON COLUMN "holiday_excluded_stores"."effective_start_date" IS '적용 시작일 — 이 날짜부터 예외(시작 전 휴일이면 휴일 시작일)';
COMMENT ON COLUMN "holiday_excluded_stores"."effective_end_date" IS '적용 종료일 — 예외를 푼 날의 전날. 비어 있으면 휴일이 끝날 때까지 예외';
COMMENT ON COLUMN "holiday_excluded_stores"."is_deleted" IS '삭제 여부 — 적용된 날이 없는 기간(오늘 더하고 오늘 뺌 · 시작 전 휴일에서 뺌)';

-- 원래 휴일 칸은 '이후 모두' 수정(분할)용이었다. 분할을 없애 새로 쓰지 않는다 — 칸은 남긴다(지우는 것은 따로).
COMMENT ON COLUMN "bp_holidays"."origin_bp_holiday_id" IS '원래 휴일 — 쓰지 않음(2026-10-26 분할 수정 폐지). 그전에 나뉜 휴일만 값이 있다';
