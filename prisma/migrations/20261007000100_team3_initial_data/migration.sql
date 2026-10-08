-- 3팀 초기 기준 데이터 — 77행 (공통코드 그룹 5 · 상세 43 · 급여 항목 29).
--
-- 근거: 네이밍 원자료(docs/raw/2026-09-30-네이밍-규칙.md) 5장 「급여 항목 코드」 표와 3팀 공통코드 확정
-- (2026-10-07 재영, 기획 세션 「3팀 공통코드」 페이지). 1팀 초기 데이터(20261006000100_team1_initial_data)와
-- 같은 방식이다 — 시드 스크립트가 아니라 마이그레이션 INSERT 라 _prisma_migrations 가 한 번만 실행되는 것을 보장한다.
--
-- 넣지 않는 것: 알림 템플릿 관리 메뉴 행과 권한(1팀 전달 사항 14번 답을 보고), 기본 알림 템플릿 37건(문구 확정 뒤
-- 다음 마이그레이션). 공통코드 NOTIFICATION_TYPE · SEND_PURPOSE 는 2026-10-07 에 없앴다 — 템플릿은 템플릿 코드로 가리킨다.
--
-- 이 파일은 손으로 쓴 데이터 마이그레이션이다. 물리 생성기(_build_physical.py)는 3팀 DDL 마이그레이션만 쓰고
-- 이 파일은 건드리지 않는다. 적용한 뒤에는 고치지 않는다 — 값을 바꿀 것은 새 마이그레이션으로 낸다.
-- 파일 끝의 검사 블록이 건수를 확인한다 — 파일이 잘려 들어가면 거기서 실패한다.

-- ── 공통코드 그룹 5개 ──
-- 다섯 그룹 모두 관리 주체가 플랫폼고정이다(2026-10-07 재영). 1팀처럼 BP 별로 복사하지 않고
-- (is_bp_applied = false) 원본 하나를 모든 BP 가 쓴다. 표시 순서는 1팀 12그룹 뒤 13~17.
INSERT INTO "code_groups" ("group_code", "group_name", "manage_owner_code", "is_bp_applied", "status", "sort_order") VALUES
  ('BANK', '은행', 'PLATFORM_FIXED', false, 'ACTIVE', 13),
  ('FAQ_CATEGORY', 'FAQ 카테고리', 'PLATFORM_FIXED', false, 'ACTIVE', 14),
  ('INQUIRY_CATEGORY', '문의 유형', 'PLATFORM_FIXED', false, 'ACTIVE', 15),
  ('INDUSTRY', '업종', 'PLATFORM_FIXED', false, 'ACTIVE', 16),
  ('PLAN_PERIOD', '도입 예정 시기', 'PLATFORM_FIXED', false, 'ACTIVE', 17);

-- ── 상세 코드 43개 ──
-- 전부 플랫폼 BP(BP000000) 소속. 상세코드는 1팀 CHECK(^[A-Z][A-Z0-9_]{0,19}$)를 따른다 —
-- 그래서 은행은 금융결제원 3자리 앞에 B 를 붙인다(B004 = 004 KB국민은행). 이체 파일을 만들 때는 B 를 뗀다.
INSERT INTO "code_items" ("group_code", "item_code", "bp_code", "label", "manage_owner_code", "status", "sort_order") VALUES
  ('BANK', 'B002', 'BP000000', 'KDB산업은행', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('BANK', 'B003', 'BP000000', 'IBK기업은행', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('BANK', 'B004', 'BP000000', 'KB국민은행', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('BANK', 'B007', 'BP000000', 'Sh수협은행', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('BANK', 'B011', 'BP000000', 'NH농협은행', 'PLATFORM_FIXED', 'ACTIVE', 5),
  ('BANK', 'B012', 'BP000000', '지역농축협', 'PLATFORM_FIXED', 'ACTIVE', 6),
  ('BANK', 'B020', 'BP000000', '우리은행', 'PLATFORM_FIXED', 'ACTIVE', 7),
  ('BANK', 'B023', 'BP000000', 'SC제일은행', 'PLATFORM_FIXED', 'ACTIVE', 8),
  ('BANK', 'B027', 'BP000000', '한국씨티은행', 'PLATFORM_FIXED', 'ACTIVE', 9),
  ('BANK', 'B031', 'BP000000', 'iM뱅크', 'PLATFORM_FIXED', 'ACTIVE', 10),
  ('BANK', 'B032', 'BP000000', '부산은행', 'PLATFORM_FIXED', 'ACTIVE', 11),
  ('BANK', 'B034', 'BP000000', '광주은행', 'PLATFORM_FIXED', 'ACTIVE', 12),
  ('BANK', 'B035', 'BP000000', '제주은행', 'PLATFORM_FIXED', 'ACTIVE', 13),
  ('BANK', 'B037', 'BP000000', '전북은행', 'PLATFORM_FIXED', 'ACTIVE', 14),
  ('BANK', 'B039', 'BP000000', '경남은행', 'PLATFORM_FIXED', 'ACTIVE', 15),
  ('BANK', 'B045', 'BP000000', '새마을금고', 'PLATFORM_FIXED', 'ACTIVE', 16),
  ('BANK', 'B048', 'BP000000', '신협', 'PLATFORM_FIXED', 'ACTIVE', 17),
  ('BANK', 'B050', 'BP000000', '저축은행', 'PLATFORM_FIXED', 'ACTIVE', 18),
  ('BANK', 'B064', 'BP000000', '산림조합', 'PLATFORM_FIXED', 'ACTIVE', 19),
  ('BANK', 'B071', 'BP000000', '우체국', 'PLATFORM_FIXED', 'ACTIVE', 20),
  ('BANK', 'B081', 'BP000000', '하나은행', 'PLATFORM_FIXED', 'ACTIVE', 21),
  ('BANK', 'B088', 'BP000000', '신한은행', 'PLATFORM_FIXED', 'ACTIVE', 22),
  ('BANK', 'B089', 'BP000000', '케이뱅크', 'PLATFORM_FIXED', 'ACTIVE', 23),
  ('BANK', 'B090', 'BP000000', '카카오뱅크', 'PLATFORM_FIXED', 'ACTIVE', 24),
  ('BANK', 'B092', 'BP000000', '토스뱅크', 'PLATFORM_FIXED', 'ACTIVE', 25),
  ('FAQ_CATEGORY', 'ACCOUNT', 'BP000000', '가입·계정', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('FAQ_CATEGORY', 'STAFF_LABOR', 'BP000000', '직원·근로', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('FAQ_CATEGORY', 'BILLING', 'BP000000', '요금·구독', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('FAQ_CATEGORY', 'STORE_FACILITY', 'BP000000', '점포·설비', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('INQUIRY_CATEGORY', 'ACCOUNT', 'BP000000', '가입·계정', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('INQUIRY_CATEGORY', 'STAFF_LABOR', 'BP000000', '직원·근로', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('INQUIRY_CATEGORY', 'BILLING', 'BP000000', '요금·구독', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('INQUIRY_CATEGORY', 'STORE_FACILITY', 'BP000000', '점포·설비', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('INQUIRY_CATEGORY', 'ETC', 'BP000000', '기타', 'PLATFORM_FIXED', 'ACTIVE', 5),
  ('INDUSTRY', 'CAFE', 'BP000000', '카페·음료', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('INDUSTRY', 'RESTAURANT', 'BP000000', '음식점', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('INDUSTRY', 'BAKERY', 'BP000000', '베이커리·디저트', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('INDUSTRY', 'PUB', 'BP000000', '주점', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('INDUSTRY', 'ETC', 'BP000000', '기타', 'PLATFORM_FIXED', 'ACTIVE', 5),
  ('PLAN_PERIOD', 'WITHIN_1M', 'BP000000', '1개월 안', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('PLAN_PERIOD', 'WITHIN_3M', 'BP000000', '3개월 안', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('PLAN_PERIOD', 'WITHIN_6M', 'BP000000', '6개월 안', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('PLAN_PERIOD', 'UNDECIDED', 'BP000000', '아직 정하지 않음', 'PLATFORM_FIXED', 'ACTIVE', 4);

-- ── 급여 항목 29개 ──
-- 공통코드가 아니라 전용 표다(2026-10-07 재영) — 항목마다 구분 · 비과세 · 시스템 계산이 붙는다.
-- 코드 · 이름 · 순서는 네이밍 원자료 「급여 항목 코드」 표 그대로. 비과세는 식대 · 자가운전보조금 · 육아수당,
-- 시스템 계산은 기본급 · 주휴수당 · 연장수당. 항목 코드는 공통코드가 아니라 20자 제한이 없다.
INSERT INTO "payslip_item_masters" ("item_code", "name", "category", "is_tax_free", "is_system_calculated", "sort_order") VALUES
  ('BASE_PAY', '기본급', 'EARNING', false, true, 1),
  ('WEEKLY_HOLIDAY_PAY', '주휴수당', 'EARNING', false, true, 2),
  ('OVERTIME_PAY', '연장수당', 'EARNING', false, true, 3),
  ('NIGHT_WORK_PAY', '야간수당', 'EARNING', false, false, 4),
  ('HOLIDAY_WORK_PAY', '휴일근무수당', 'EARNING', false, false, 5),
  ('EXTRA_WORK_PAY', '추가근무수당', 'EARNING', false, false, 6),
  ('ANNUAL_LEAVE_PAY', '연차수당', 'EARNING', false, false, 7),
  ('BONUS', '상여', 'EARNING', false, false, 8),
  ('MEAL_ALLOWANCE', '식대', 'EARNING', true, false, 9),
  ('CAR_ALLOWANCE', '자가운전보조금', 'EARNING', true, false, 10),
  ('CHILDCARE_ALLOWANCE', '육아수당', 'EARNING', true, false, 11),
  ('NATIONAL_PENSION', '국민연금', 'BASIC', false, false, 12),
  ('HEALTH_INSURANCE', '건강보험', 'BASIC', false, false, 13),
  ('EMPLOYMENT_INSURANCE', '고용보험', 'BASIC', false, false, 14),
  ('LONG_TERM_CARE_INSURANCE', '장기요양보험', 'BASIC', false, false, 15),
  ('INCOME_TAX', '소득세', 'BASIC', false, false, 16),
  ('LOCAL_INCOME_TAX', '지방소득세', 'BASIC', false, false, 17),
  ('YEAR_END_SETTLEMENT', '연말(중도)정산', 'ADDITIONAL', false, false, 18),
  ('YEAR_END_INCOME_TAX', '연말(중도)정산 소득세', 'ADDITIONAL', false, false, 19),
  ('YEAR_END_LOCAL_TAX', '연말(중도)정산 주민세', 'ADDITIONAL', false, false, 20),
  ('HEALTH_INSURANCE_SETTLEMENT', '건강보험정산', 'ADDITIONAL', false, false, 21),
  ('LONG_TERM_CARE_SETTLEMENT', '장기요양보험정산', 'ADDITIONAL', false, false, 22),
  ('EMPLOYMENT_INSURANCE_SETTLEMENT', '고용보험정산', 'ADDITIONAL', false, false, 23),
  ('NATIONAL_PENSION_SETTLEMENT', '국민연금정산', 'ADDITIONAL', false, false, 24),
  ('LONG_TERM_CARE_ASSESSMENT', '장기요양보험산정', 'ADDITIONAL', false, false, 25),
  ('RETIREMENT_RESERVE', '퇴사자유보금', 'ADDITIONAL', false, false, 26),
  ('STOCK_OPTION', '스톡옵션', 'ADDITIONAL', false, false, 27),
  ('BUSINESS_INCOME_TAX', '사업소득세(3%)', 'WITHHOLDING', false, false, 28),
  ('BUSINESS_LOCAL_INCOME_TAX', '지방소득세(0.3%)', 'WITHHOLDING', false, false, 29);

-- ── 건수 검사 ──
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM "code_groups"
   WHERE "group_code" IN ('BANK', 'FAQ_CATEGORY', 'INQUIRY_CATEGORY', 'INDUSTRY', 'PLAN_PERIOD');
  IF n <> 5 THEN RAISE EXCEPTION '3팀 공통코드 그룹이 5개가 아니다: %', n; END IF;

  SELECT count(*) INTO n FROM "code_items" WHERE "bp_code" = 'BP000000'
   AND "group_code" IN ('BANK', 'FAQ_CATEGORY', 'INQUIRY_CATEGORY', 'INDUSTRY', 'PLAN_PERIOD');
  IF n <> 43 THEN RAISE EXCEPTION '3팀 상세 코드가 43개가 아니다: %', n; END IF;

  IF (SELECT count(*) FROM "code_items" WHERE "group_code" = 'BANK') <> 25
     OR (SELECT count(*) FROM "code_items" WHERE "group_code" = 'FAQ_CATEGORY') <> 4
     OR (SELECT count(*) FROM "code_items" WHERE "group_code" = 'INQUIRY_CATEGORY') <> 5
     OR (SELECT count(*) FROM "code_items" WHERE "group_code" = 'INDUSTRY') <> 5
     OR (SELECT count(*) FROM "code_items" WHERE "group_code" = 'PLAN_PERIOD') <> 4 THEN
    RAISE EXCEPTION '3팀 공통코드 그룹별 건수가 맞지 않다(BANK 25 · FAQ 4 · INQUIRY 5 · INDUSTRY 5 · PLAN_PERIOD 4)';
  END IF;

  SELECT count(*) INTO n FROM "payslip_item_masters";
  IF n <> 29 THEN RAISE EXCEPTION '급여 항목이 29개가 아니다: %', n; END IF;
  IF (SELECT count(*) FROM "payslip_item_masters" WHERE "category" = 'EARNING') <> 11
     OR (SELECT count(*) FROM "payslip_item_masters" WHERE "category" = 'BASIC') <> 6
     OR (SELECT count(*) FROM "payslip_item_masters" WHERE "category" = 'ADDITIONAL') <> 10
     OR (SELECT count(*) FROM "payslip_item_masters" WHERE "category" = 'WITHHOLDING') <> 2 THEN
    RAISE EXCEPTION '급여 항목 구분별 건수가 맞지 않다(지급 11 · 기본 공제 6 · 추가 공제 10 · 원천징수 2)';
  END IF;
  IF (SELECT string_agg("item_code", ',' ORDER BY "item_code") FROM "payslip_item_masters" WHERE "is_tax_free")
     <> 'CAR_ALLOWANCE,CHILDCARE_ALLOWANCE,MEAL_ALLOWANCE' THEN
    RAISE EXCEPTION '비과세 항목이 식대 · 자가운전보조금 · 육아수당이 아니다';
  END IF;
  IF (SELECT string_agg("item_code", ',' ORDER BY "item_code") FROM "payslip_item_masters" WHERE "is_system_calculated")
     <> 'BASE_PAY,OVERTIME_PAY,WEEKLY_HOLIDAY_PAY' THEN
    RAISE EXCEPTION '시스템 계산 항목이 기본급 · 주휴수당 · 연장수당이 아니다';
  END IF;
END $$;
