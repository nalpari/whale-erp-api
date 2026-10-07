-- 1팀 초기 기준 데이터 — 245행 (플랫폼 BP 1 · 공통코드 12+52 · 메뉴 64 ·
-- 권한 그룹 3 · 메뉴 권한 106 · 플랫폼 마스터 1 · 약관 버전 6).
--
-- 근거: whale-erp-new-front 의 docs/seed/initial-data-request.md Ⅰ장 · Ⅱ-1~4.
-- 명세의 공통코드 13그룹 중 MAIL_TYPE(메일 유형, 상세 8개)은 넣지 않는다 — 메일 유형은
-- 메일 템플릿을 따로 관리해 그 정보를 쓴다(재영, 2026-10-07). 같은 목록을 공통코드에도
-- 두면 템플릿과 어긋난다. mail_send_logs.mail_type_code 는 외래키 없는 코드값 컬럼이라
-- 그대로 두고, 앞으로 템플릿의 식별값을 담는다.
-- 코드값·코드명은 Manyfast 기능명세서(F-KYIMYU 공통코드) 를 따른다.
--
-- 시드(prisma/seed.ts)가 아니라 마이그레이션에 두는 이유: 이 행들은 환경마다
-- 다르지 않다. 마이그레이션에 두면 Prisma 가 _prisma_migrations 에 기록해 한 번만
-- 실행되는 것이 구조적으로 보장되고, "스키마를 적용했다" 가 "앱이 뜰 수 있다" 와
-- 같아진다 — 메뉴·권한 테이블이 빈 채로 뜨는 일이 없다.
--
-- 시드에 남는 것은 규칙으로 계산해야 하는 공식 휴일 1346행뿐이다.
--
-- 이 파일에는 비밀이 없다. 플랫폼 마스터는 쓸 수 있는 비밀번호 없이 들어가고,
-- 첫 로그인은 임시 비밀번호 발급으로 한다 — 그 행의 주석에 적어 뒀다.
--
-- 기본키는 GENERATED ALWAYS AS IDENTITY 라 값을 미리 알 수 없다. 그래서 자식 행은
-- id 를 적지 않고 코드값(bp_code · menu_code · role_code)으로 조인해 넣는다.
-- 파일 끝의 검사 블록이 건수를 확인한다 — 파일이 잘려 들어가면 거기서 실패한다.

-- ── 플랫폼 BP ──
-- BP000000 은 고객 BP 채번에서 빼는 예약 코드다. is_platform 이 true 인 행은
-- 부분 고유 인덱스가 하나로 제한한다. 사업자등록번호는 운영 회사의 실제 번호가
-- 정해지면 화면에서 넣는다 — 플랫폼 BP 는 중복 검사 대상이 아니라 비워 둘 수 있다.
INSERT INTO "bp_codes" ("bp_code", "is_platform", "account_status_code", "trade_name")
VALUES ('BP000000', true, 'ACTIVE', 'Whale ERP Platform');

-- ── 공통코드 그룹 12개 ──
-- 열세 그룹 모두 관리 주체가 플랫폼고정이다 — 값에 업무 규칙이 묶여 있어 BP 가
-- 고치면 판정이 깨진다. 그래서 BP 별로 복사하지 않고(is_bp_applied = false)
-- 원본 하나를 모든 BP 가 그대로 쓴다.
INSERT INTO "code_groups" ("group_code", "group_name", "manage_owner_code", "is_bp_applied", "status", "sort_order") VALUES
  ('SERVICE', '서비스', 'PLATFORM_FIXED', false, 'ACTIVE', 1),
  ('ROLE_TYPE', '권한 유형', 'PLATFORM_FIXED', false, 'ACTIVE', 2),
  ('ACCOUNT_STATUS', '계정 상태', 'PLATFORM_FIXED', false, 'ACTIVE', 3),
  ('JOIN_PATH', '가입경로', 'PLATFORM_FIXED', false, 'ACTIVE', 4),
  ('WITHDRAW_REASON', '탈퇴 사유', 'PLATFORM_FIXED', false, 'ACTIVE', 5),
  ('TERMS_TYPE', '약관 유형', 'PLATFORM_FIXED', false, 'ACTIVE', 6),
  ('FLOOR_TYPE', '층수 구분', 'PLATFORM_FIXED', false, 'ACTIVE', 7),
  ('STORE_STATUS', '점포 상태', 'PLATFORM_FIXED', false, 'ACTIVE', 8),
  ('STORE_TYPE', '점포 유형', 'PLATFORM_FIXED', false, 'ACTIVE', 9),
  ('MANAGE_OWNER', '관리 주체', 'PLATFORM_FIXED', false, 'ACTIVE', 10),
  ('HOLIDAY_TYPE', '휴일 유형', 'PLATFORM_FIXED', false, 'ACTIVE', 11),
  ('HOLIDAY_REPEAT_TYPE', '휴일 반복 유형', 'PLATFORM_FIXED', false, 'ACTIVE', 12);

-- ── 상세 코드 52개 ──
-- 전부 플랫폼 BP 소속이다. (그룹 코드, 상세코드, BP 코드) 가 복합 기본키라
-- BP 가 적용할 때 자기 BP 코드로 복사된 행이 따로 쌓인다.
INSERT INTO "code_items" ("group_code", "item_code", "bp_code", "label", "manage_owner_code", "status", "sort_order") VALUES
  ('SERVICE', 'WHALE_ERP', 'BP000000', 'Whale ERP', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('SERVICE', 'PLATFORM', 'BP000000', 'Whale ERP 플랫폼 관리', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('SERVICE', 'POS', 'BP000000', 'POS', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('SERVICE', 'KIOSK', 'BP000000', 'KIOSK', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('SERVICE', 'TABLE_ORDER', 'BP000000', 'Table Order', 'PLATFORM_FIXED', 'ACTIVE', 5),
  ('SERVICE', 'PICK_UP_ORDER', 'BP000000', 'Pick Up Order', 'PLATFORM_FIXED', 'ACTIVE', 6),
  ('SERVICE', 'QR_ORDER', 'BP000000', 'QR Order', 'PLATFORM_FIXED', 'ACTIVE', 7),
  ('SERVICE', 'RECIPE_MANAGEMENT', 'BP000000', '레시피관리', 'PLATFORM_FIXED', 'ACTIVE', 8),
  ('SERVICE', 'ORDER_MANAGEMENT', 'BP000000', '발주관리', 'PLATFORM_FIXED', 'ACTIVE', 9),
  ('SERVICE', 'STORE_INVENTORY', 'BP000000', '점포재고관리', 'PLATFORM_FIXED', 'ACTIVE', 10),
  ('SERVICE', 'WAITING_MANAGEMENT', 'BP000000', '대기순번관리', 'PLATFORM_FIXED', 'ACTIVE', 11),
  ('SERVICE', 'RESERVATION', 'BP000000', '예약관리', 'PLATFORM_FIXED', 'ACTIVE', 12),
  ('ROLE_TYPE', 'PM', 'BP000000', '플랫폼 마스터', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('ROLE_TYPE', 'PA', 'BP000000', '플랫폼 관리자', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('ROLE_TYPE', 'BM', 'BP000000', 'BP 마스터', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('ROLE_TYPE', 'BA', 'BP000000', 'BP 관리자', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('ROLE_TYPE', 'FM', 'BP000000', '가맹 마스터', 'PLATFORM_FIXED', 'ACTIVE', 5),
  ('ROLE_TYPE', 'FA', 'BP000000', '가맹 관리자', 'PLATFORM_FIXED', 'ACTIVE', 6),
  ('ACCOUNT_STATUS', 'ACTIVE', 'BP000000', '사용', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('ACCOUNT_STATUS', 'INACTIVE', 'BP000000', '미사용', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('ACCOUNT_STATUS', 'WITHDRAWN', 'BP000000', '탈퇴', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('JOIN_PATH', 'SIGNUP', 'BP000000', '회원가입', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('JOIN_PATH', 'PLATFORM_REGISTERED', 'BP000000', '플랫폼등록', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('WITHDRAW_REASON', 'WD_CLOSE', 'BP000000', '폐업·사업 종료', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('WITHDRAW_REASON', 'WD_SWITCH', 'BP000000', '다른 서비스 이용', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('WITHDRAW_REASON', 'WD_COST', 'BP000000', '비용 부담', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('WITHDRAW_REASON', 'WD_FEATURE', 'BP000000', '기능 부족', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('WITHDRAW_REASON', 'WD_HARD', 'BP000000', '이용이 어려움', 'PLATFORM_FIXED', 'ACTIVE', 5),
  ('WITHDRAW_REASON', 'WD_INPUT', 'BP000000', '직접입력', 'PLATFORM_FIXED', 'ACTIVE', 6),
  ('TERMS_TYPE', 'TERMS_SERVICE', 'BP000000', '이용약관(BP 사업자 회원가입용)', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('TERMS_TYPE', 'PRIVACY_COLLECT', 'BP000000', '개인정보 수집·이용 동의(BP 사업자 회원가입용)', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('TERMS_TYPE', 'STAFF_TERMS_SERVICE', 'BP000000', '이용약관(직원 근무 앱 회원가입용)', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('TERMS_TYPE', 'STAFF_PRIVACY', 'BP000000', '개인정보 수집·이용 동의(직원 근무 앱 회원가입용)', 'PLATFORM_FIXED', 'ACTIVE', 4),
  ('TERMS_TYPE', 'MARKETING', 'BP000000', '마케팅 수신 동의', 'PLATFORM_FIXED', 'ACTIVE', 5),
  ('TERMS_TYPE', 'LOCATION', 'BP000000', '위치정보 수집·이용 동의', 'PLATFORM_FIXED', 'ACTIVE', 6),
  ('FLOOR_TYPE', 'GROUND', 'BP000000', '지상', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('FLOOR_TYPE', 'BASEMENT', 'BP000000', '지하', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('STORE_STATUS', 'NOT_OPERATING', 'BP000000', '미운영', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('STORE_STATUS', 'OPERATING', 'BP000000', '운영', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('STORE_STATUS', 'CLOSED', 'BP000000', '폐점', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('STORE_TYPE', 'DIRECT', 'BP000000', '직영점포', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('STORE_TYPE', 'FRANCHISE', 'BP000000', '가맹점포', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('MANAGE_OWNER', 'PLATFORM_FIXED', 'BP000000', '플랫폼고정', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('MANAGE_OWNER', 'PLATFORM_PROVIDED', 'BP000000', '플랫폼제공', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('MANAGE_OWNER', 'BP_ONLY', 'BP000000', 'BP전용', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('HOLIDAY_TYPE', 'DAY', 'BP000000', '하루', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('HOLIDAY_TYPE', 'PERIOD', 'BP000000', '기간', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('HOLIDAY_TYPE', 'REPEAT', 'BP000000', '반복', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('HOLIDAY_REPEAT_TYPE', 'DAILY', 'BP000000', '매일', 'PLATFORM_FIXED', 'ACTIVE', 1),
  ('HOLIDAY_REPEAT_TYPE', 'WEEKLY', 'BP000000', '매주', 'PLATFORM_FIXED', 'ACTIVE', 2),
  ('HOLIDAY_REPEAT_TYPE', 'MONTHLY', 'BP000000', '매월', 'PLATFORM_FIXED', 'ACTIVE', 3),
  ('HOLIDAY_REPEAT_TYPE', 'YEARLY', 'BP000000', '매년', 'PLATFORM_FIXED', 'ACTIVE', 4);

-- ── 메뉴 64개 (플랫폼 관리 22 · Whale ERP 42) ──
-- 상위 메뉴는 두 번에 나눠 넣는다 — menu_id 가 IDENTITY 라 INSERT 시점에
-- 부모의 id 를 알 수 없다. 먼저 전부 넣고, 아래 UPDATE 가 menu_code 로 잇는다.
INSERT INTO "menus" ("menu_code", "service_code", "name", "url", "sort_order", "depth", "status") VALUES
  ('MN000201', 'PLATFORM', '회원관리', NULL, 1, 1, 'INACTIVE'),
  ('MN000202', 'PLATFORM', '회원 정보 관리', NULL, 1, 2, 'INACTIVE'),
  ('MN000203', 'PLATFORM', 'BP 마스터 계정 관리', '/platform/bp', 2, 1, 'ACTIVE'),
  ('MN000204', 'PLATFORM', '서비스정산관리', NULL, 3, 1, 'INACTIVE'),
  ('MN000205', 'PLATFORM', '부가서비스 주문 내역', NULL, 1, 2, 'INACTIVE'),
  ('MN000206', 'PLATFORM', '부가서비스 정산', NULL, 2, 2, 'INACTIVE'),
  ('MN000207', 'PLATFORM', '부가서비스관리', NULL, 4, 1, 'INACTIVE'),
  ('MN000208', 'PLATFORM', '부가 서비스 정보 관리', NULL, 1, 2, 'INACTIVE'),
  ('MN000209', 'PLATFORM', '프로모션관리', NULL, 5, 1, 'INACTIVE'),
  ('MN000210', 'PLATFORM', '쿠폰 관리', NULL, 1, 2, 'INACTIVE'),
  ('MN000211', 'PLATFORM', '포인트 관리', NULL, 2, 2, 'INACTIVE'),
  ('MN000212', 'PLATFORM', '시스템관리', NULL, 6, 1, 'ACTIVE'),
  ('MN000213', 'PLATFORM', '플랫폼 관리자 관리', '/platform/system/admins', 1, 2, 'ACTIVE'),
  ('MN000214', 'PLATFORM', '플랫폼 권한 관리', '/platform/system/roles', 2, 2, 'ACTIVE'),
  ('MN000215', 'PLATFORM', '플랫폼 메뉴 관리', '/platform/system/menus', 3, 2, 'ACTIVE'),
  ('MN000216', 'PLATFORM', '플랫폼 공통코드 관리', '/platform/system/codes', 4, 2, 'ACTIVE'),
  ('MN000217', 'PLATFORM', '플랫폼 휴일 관리', '/platform/system/holidays', 5, 2, 'ACTIVE'),
  ('MN000218', 'PLATFORM', '커뮤니티관리', NULL, 7, 1, 'ACTIVE'),
  ('MN000219', 'PLATFORM', '공지사항', '/platform/community/notices', 1, 2, 'ACTIVE'),
  ('MN000220', 'PLATFORM', 'FAQ', '/platform/community/faq', 2, 2, 'ACTIVE'),
  ('MN000221', 'PLATFORM', '문의사항', '/platform/community/inquiries', 3, 2, 'ACTIVE'),
  ('MN000222', 'PLATFORM', '도입문의', '/platform/community/leads', 4, 2, 'ACTIVE'),
  ('MN000016', 'WHALE_ERP', '기초정보관리', NULL, 1, 1, 'INACTIVE'),
  ('MN000017', 'WHALE_ERP', '상품 정보 관리', '/products', 1, 2, 'INACTIVE'),
  ('MN000018', 'WHALE_ERP', '가격 정보 관리', '/prices', 2, 2, 'INACTIVE'),
  ('MN000019', 'WHALE_ERP', '카테고리 정보 관리', '/categories', 3, 2, 'INACTIVE'),
  ('MN000020', 'WHALE_ERP', '자재 정보 관리', '/materials', 4, 2, 'INACTIVE'),
  ('MN000001', 'WHALE_ERP', '점포관리', NULL, 2, 1, 'ACTIVE'),
  ('MN000002', 'WHALE_ERP', '점포 정보 관리', '/stores', 1, 2, 'ACTIVE'),
  ('MN000003', 'WHALE_ERP', '계약서 템플릿 관리', '/stores/contract-templates', 2, 2, 'INACTIVE'),
  ('MN000021', 'WHALE_ERP', '계약서 관리', '/stores/contracts', 3, 2, 'INACTIVE'),
  ('MN000022', 'WHALE_ERP', '시설물 및 장비 관리', '/stores/facilities', 4, 2, 'INACTIVE'),
  ('MN000023', 'WHALE_ERP', '점검표 템플릿 관리', '/stores/checklist-templates', 5, 2, 'INACTIVE'),
  ('MN000024', 'WHALE_ERP', '점검 결과 관리', '/stores/inspections', 6, 2, 'INACTIVE'),
  ('MN000004', 'WHALE_ERP', '직원관리', NULL, 3, 1, 'ACTIVE'),
  ('MN000005', 'WHALE_ERP', '직원 정보 관리', '/staff', 1, 2, 'ACTIVE'),
  ('MN000006', 'WHALE_ERP', '근로계약 관리', NULL, 2, 2, 'ACTIVE'),
  ('MN000007', 'WHALE_ERP', '계약 목록', '/staff/contracts', 1, 3, 'ACTIVE'),
  ('MN000008', 'WHALE_ERP', '근로계약서 초안 작성', '/staff/contracts/new', 2, 3, 'ACTIVE'),
  ('MN000009', 'WHALE_ERP', '급여명세서 관리', '/staff/payrolls', 3, 2, 'ACTIVE'),
  ('MN000010', 'WHALE_ERP', '근무스케줄 관리', '/staff/schedules', 4, 2, 'ACTIVE'),
  ('MN000025', 'WHALE_ERP', '출·퇴근 현황 조회', '/staff/attendance', 5, 2, 'ACTIVE'),
  ('MN000026', 'WHALE_ERP', 'TO-DO 리스트 관리', '/staff/todos', 6, 2, 'ACTIVE'),
  ('MN000027', 'WHALE_ERP', '매출조회', NULL, 4, 1, 'INACTIVE'),
  ('MN000028', 'WHALE_ERP', '매출 조회', '/sales', 1, 2, 'INACTIVE'),
  ('MN000029', 'WHALE_ERP', '매출 통계', '/sales/statistics', 2, 2, 'INACTIVE'),
  ('MN000030', 'WHALE_ERP', '재무관리', NULL, 5, 1, 'INACTIVE'),
  ('MN000031', 'WHALE_ERP', '입·출금 관리', '/finance/transactions', 1, 2, 'INACTIVE'),
  ('MN000032', 'WHALE_ERP', '매출/매입 거래 등록', '/finance/trades', 2, 2, 'INACTIVE'),
  ('MN000033', 'WHALE_ERP', '계정별 현황 조회', '/finance/accounts', 3, 2, 'INACTIVE'),
  ('MN000034', 'WHALE_ERP', '고객지원', NULL, 6, 1, 'ACTIVE'),
  ('MN000035', 'WHALE_ERP', '공지사항', '/support/notices', 1, 2, 'ACTIVE'),
  ('MN000036', 'WHALE_ERP', '문의하기', '/support/inquiries', 2, 2, 'ACTIVE'),
  ('MN000037', 'WHALE_ERP', '부가서비스 구독 관리', '/support/subscriptions', 3, 2, 'INACTIVE'),
  ('MN000038', 'WHALE_ERP', '구독료 청구 및 납부 현황', '/support/billing', 4, 2, 'INACTIVE'),
  ('MN000039', 'WHALE_ERP', '결제수단 관리', '/support/payment-methods', 5, 2, 'INACTIVE'),
  ('MN000040', 'WHALE_ERP', '정산 현황 조회', '/support/settlements', 6, 2, 'INACTIVE'),
  ('MN000041', 'WHALE_ERP', '운영 알림', NULL, 7, 1, 'ACTIVE'),
  ('MN000042', 'WHALE_ERP', '알림함', '/notifications', 1, 2, 'ACTIVE'),
  ('MN000011', 'WHALE_ERP', '환경설정', NULL, 8, 1, 'ACTIVE'),
  ('MN000012', 'WHALE_ERP', 'BP 관리자 관리', '/settings/admins', 1, 2, 'ACTIVE'),
  ('MN000013', 'WHALE_ERP', 'BP 권한 그룹 관리', '/settings/roles', 2, 2, 'ACTIVE'),
  ('MN000014', 'WHALE_ERP', 'BP 공통코드 관리', '/settings/codes', 3, 2, 'ACTIVE'),
  ('MN000015', 'WHALE_ERP', 'BP 휴일 관리', '/settings/holidays', 4, 2, 'ACTIVE');

-- 상위 메뉴 연결 49건 (1단계 메뉴는 상위가 없다)
UPDATE "menus" AS m
SET "parent_menu_id" = p."menu_id"
FROM (VALUES
  ('MN000202', 'MN000201'),
  ('MN000205', 'MN000204'),
  ('MN000206', 'MN000204'),
  ('MN000208', 'MN000207'),
  ('MN000210', 'MN000209'),
  ('MN000211', 'MN000209'),
  ('MN000213', 'MN000212'),
  ('MN000214', 'MN000212'),
  ('MN000215', 'MN000212'),
  ('MN000216', 'MN000212'),
  ('MN000217', 'MN000212'),
  ('MN000219', 'MN000218'),
  ('MN000220', 'MN000218'),
  ('MN000221', 'MN000218'),
  ('MN000222', 'MN000218'),
  ('MN000017', 'MN000016'),
  ('MN000018', 'MN000016'),
  ('MN000019', 'MN000016'),
  ('MN000020', 'MN000016'),
  ('MN000002', 'MN000001'),
  ('MN000003', 'MN000001'),
  ('MN000021', 'MN000001'),
  ('MN000022', 'MN000001'),
  ('MN000023', 'MN000001'),
  ('MN000024', 'MN000001'),
  ('MN000005', 'MN000004'),
  ('MN000006', 'MN000004'),
  ('MN000007', 'MN000006'),
  ('MN000008', 'MN000006'),
  ('MN000009', 'MN000004'),
  ('MN000010', 'MN000004'),
  ('MN000025', 'MN000004'),
  ('MN000026', 'MN000004'),
  ('MN000028', 'MN000027'),
  ('MN000029', 'MN000027'),
  ('MN000031', 'MN000030'),
  ('MN000032', 'MN000030'),
  ('MN000033', 'MN000030'),
  ('MN000035', 'MN000034'),
  ('MN000036', 'MN000034'),
  ('MN000037', 'MN000034'),
  ('MN000038', 'MN000034'),
  ('MN000039', 'MN000034'),
  ('MN000040', 'MN000034'),
  ('MN000042', 'MN000041'),
  ('MN000012', 'MN000011'),
  ('MN000013', 'MN000011'),
  ('MN000014', 'MN000011'),
  ('MN000015', 'MN000011')
) AS rel(child_code, parent_code)
JOIN "menus" AS p ON p."menu_code" = rel.parent_code
WHERE m."menu_code" = rel.child_code;

-- ── 고정 권한 그룹 3개 ──
-- 셋 다 마스터 권한이고 플랫폼 BP 소속이다. role_code 는 CHECK 제약이
-- ^[A-Z]{2}[0-9]{6}$ 라 권한 유형 2글자 + 6자리다.
--
-- 넣지 않는 것: PA 고정 권한(플랫폼 마스터가 플랫폼 권한 관리에서 처음 등록하는
-- 것이 PA000001 이 된다), BA·FA 권한 그룹(각 BP 가 화면에서 만든다).
INSERT INTO "role_groups" ("role_code", "bp_code_id", "role_type_code", "name", "description", "is_master")
SELECT x.role_code, bp."bp_code_id", x.role_type_code, x.name, x.description, true
FROM (VALUES
  ('PM000001', 'PM', '플랫폼 마스터', '전체 메뉴 허용 고정 · 조회 전용'),
  ('BM000001', 'BM', 'BP 마스터', 'BP 관리자 권한 그룹의 상한'),
  ('FM000001', 'FM', '가맹 마스터', '가맹 관리자 권한 그룹의 상한')
) AS x(role_code, role_type_code, name, description)
JOIN "bp_codes" AS bp ON bp."bp_code" = 'BP000000';

-- ── 고정 권한별 메뉴 권한 106건 ──
-- PM000001 64건: 모든 메뉴. 하위가 있는 묶음 메뉴는 조회만 —
--   그 자체로 열 화면이 없어 등록·수정을 켜 두면 의미 없는 체크로 보인다.
-- BM000001 21건: Whale ERP 의 사용 중인 메뉴만. 플랫폼 메뉴는 주지 않는다.
-- FM000001 21건: 명세(Ⅱ-4)에 메뉴마다 적힌 권한 그대로.
-- 등록·수정·삭제가 켜지면 조회도 켠다.
INSERT INTO "role_group_menus" ("role_group_id", "menu_id", "is_readable", "is_creatable", "is_updatable", "is_deletable")
SELECT rg."role_group_id", m."menu_id", x.r, x.c, x.u, x.d
FROM (VALUES
  ('PM000001', 'MN000201', true, false, false, false),
  ('PM000001', 'MN000202', true, true, true, true),
  ('PM000001', 'MN000203', true, true, true, true),
  ('PM000001', 'MN000204', true, false, false, false),
  ('PM000001', 'MN000205', true, true, true, true),
  ('PM000001', 'MN000206', true, true, true, true),
  ('PM000001', 'MN000207', true, false, false, false),
  ('PM000001', 'MN000208', true, true, true, true),
  ('PM000001', 'MN000209', true, false, false, false),
  ('PM000001', 'MN000210', true, true, true, true),
  ('PM000001', 'MN000211', true, true, true, true),
  ('PM000001', 'MN000212', true, false, false, false),
  ('PM000001', 'MN000213', true, true, true, true),
  ('PM000001', 'MN000214', true, true, true, true),
  ('PM000001', 'MN000215', true, true, true, true),
  ('PM000001', 'MN000216', true, true, true, true),
  ('PM000001', 'MN000217', true, true, true, true),
  ('PM000001', 'MN000218', true, false, false, false),
  ('PM000001', 'MN000219', true, true, true, true),
  ('PM000001', 'MN000220', true, true, true, true),
  ('PM000001', 'MN000221', true, true, true, true),
  ('PM000001', 'MN000222', true, true, true, true),
  ('PM000001', 'MN000016', true, false, false, false),
  ('PM000001', 'MN000017', true, true, true, true),
  ('PM000001', 'MN000018', true, true, true, true),
  ('PM000001', 'MN000019', true, true, true, true),
  ('PM000001', 'MN000020', true, true, true, true),
  ('PM000001', 'MN000001', true, false, false, false),
  ('PM000001', 'MN000002', true, true, true, true),
  ('PM000001', 'MN000003', true, true, true, true),
  ('PM000001', 'MN000021', true, true, true, true),
  ('PM000001', 'MN000022', true, true, true, true),
  ('PM000001', 'MN000023', true, true, true, true),
  ('PM000001', 'MN000024', true, true, true, true),
  ('PM000001', 'MN000004', true, false, false, false),
  ('PM000001', 'MN000005', true, true, true, true),
  ('PM000001', 'MN000006', true, false, false, false),
  ('PM000001', 'MN000007', true, true, true, true),
  ('PM000001', 'MN000008', true, true, true, true),
  ('PM000001', 'MN000009', true, true, true, true),
  ('PM000001', 'MN000010', true, true, true, true),
  ('PM000001', 'MN000025', true, true, true, true),
  ('PM000001', 'MN000026', true, true, true, true),
  ('PM000001', 'MN000027', true, false, false, false),
  ('PM000001', 'MN000028', true, true, true, true),
  ('PM000001', 'MN000029', true, true, true, true),
  ('PM000001', 'MN000030', true, false, false, false),
  ('PM000001', 'MN000031', true, true, true, true),
  ('PM000001', 'MN000032', true, true, true, true),
  ('PM000001', 'MN000033', true, true, true, true),
  ('PM000001', 'MN000034', true, false, false, false),
  ('PM000001', 'MN000035', true, true, true, true),
  ('PM000001', 'MN000036', true, true, true, true),
  ('PM000001', 'MN000037', true, true, true, true),
  ('PM000001', 'MN000038', true, true, true, true),
  ('PM000001', 'MN000039', true, true, true, true),
  ('PM000001', 'MN000040', true, true, true, true),
  ('PM000001', 'MN000041', true, false, false, false),
  ('PM000001', 'MN000042', true, true, true, true),
  ('PM000001', 'MN000011', true, false, false, false),
  ('PM000001', 'MN000012', true, true, true, true),
  ('PM000001', 'MN000013', true, true, true, true),
  ('PM000001', 'MN000014', true, true, true, true),
  ('PM000001', 'MN000015', true, true, true, true),
  ('BM000001', 'MN000001', true, false, false, false),
  ('BM000001', 'MN000002', true, true, true, true),
  ('BM000001', 'MN000004', true, false, false, false),
  ('BM000001', 'MN000005', true, true, true, true),
  ('BM000001', 'MN000006', true, false, false, false),
  ('BM000001', 'MN000007', true, true, true, true),
  ('BM000001', 'MN000008', true, true, true, true),
  ('BM000001', 'MN000009', true, true, true, true),
  ('BM000001', 'MN000010', true, true, true, true),
  ('BM000001', 'MN000025', true, true, true, true),
  ('BM000001', 'MN000026', true, true, true, true),
  ('BM000001', 'MN000034', true, false, false, false),
  ('BM000001', 'MN000035', true, true, true, true),
  ('BM000001', 'MN000036', true, true, true, true),
  ('BM000001', 'MN000041', true, false, false, false),
  ('BM000001', 'MN000042', true, true, true, true),
  ('BM000001', 'MN000011', true, false, false, false),
  ('BM000001', 'MN000012', true, true, true, true),
  ('BM000001', 'MN000013', true, true, true, true),
  ('BM000001', 'MN000014', true, true, true, true),
  ('BM000001', 'MN000015', true, true, true, true),
  ('FM000001', 'MN000001', true, false, false, false),
  ('FM000001', 'MN000002', true, false, true, false),
  ('FM000001', 'MN000004', true, false, false, false),
  ('FM000001', 'MN000005', true, true, true, false),
  ('FM000001', 'MN000006', true, false, false, false),
  ('FM000001', 'MN000007', true, true, true, false),
  ('FM000001', 'MN000008', true, true, true, false),
  ('FM000001', 'MN000009', true, false, false, false),
  ('FM000001', 'MN000010', true, true, true, false),
  ('FM000001', 'MN000025', true, false, false, false),
  ('FM000001', 'MN000026', true, true, true, false),
  ('FM000001', 'MN000011', true, false, false, false),
  ('FM000001', 'MN000012', true, true, true, false),
  ('FM000001', 'MN000013', true, true, true, false),
  ('FM000001', 'MN000014', true, false, false, false),
  ('FM000001', 'MN000015', true, true, true, true),
  ('FM000001', 'MN000034', true, false, false, false),
  ('FM000001', 'MN000035', true, false, false, false),
  ('FM000001', 'MN000036', true, true, false, false),
  ('FM000001', 'MN000041', true, false, false, false),
  ('FM000001', 'MN000042', true, false, false, false)
) AS x(role_code, menu_code, r, c, u, d)
JOIN "role_groups" AS rg ON rg."role_code" = x.role_code
JOIN "menus" AS m ON m."menu_code" = x.menu_code;

-- ── 최초 플랫폼 마스터 1건 — 비밀번호 없이 ──
-- 권한 그룹이 먼저 있어야 한다 — role_group_id 가 NOT NULL 이다.
--
-- **이 파일에는 비밀이 없다.** password_hash 는 NOT NULL 이라 값이 있어야 하지만,
-- 쓸 수 있는 비밀번호를 넣지 않고 '!' 를 넣는다. verifyPassword 는 저장값을 '$' 로
-- 쪼개 scheme 가 'scrypt' 인지 먼저 보므로, '!' 는 어떤 입력과도 맞지 않고 예외도
-- 던지지 않는다 — 빈 문자열·'!'·실제 비밀번호 모두 false 로 거부되는 것을 확인했다.
-- /etc/shadow 가 잠긴 계정을 '!' 로 표시하는 관례와 같다.
--
-- 그래서 첫 로그인은 비밀번호 찾기의 **임시 비밀번호 발급**으로 한다. 계정 정보
-- (login_id · email)는 여기 적혀 있어도 로그인 수단이 아니다 — 수단은 아래 메일
-- 주소의 수신함이고, 그 수신함을 가진 사람만 들어올 수 있다.
--
-- 바꿔 말하면 **이 계정의 보안은 rjy1537@interplug.co.kr 수신함의 보안과 같다.**
-- 비밀번호를 커밋했을 때 생기던 「적용 ~ 첫 변경」 노출 구간은 사라졌다.
--
-- 지금은 들어갈 수 없다: 1팀 인증(로그인 · 계정 찾기 · 임시 비밀번호 발급)과 메일
-- 발송이 아직 구현 전이다. 의도한 상태다 — 쓸 수 있는 비밀번호가 git 에 남는 것보다
-- 당장 로그인이 안 되는 편이 낫다. 로컬에서 비밀번호를 직접 넣어야 하면
-- 다음 한 줄로 해시를 만들어 UPDATE 한다(그 값은 커밋하지 않는다):
--   npx ts-node -T -e "import('./src/auth/password').then(m=>m.hashPassword('비번').then(console.log))"
--
-- 연락처는 비워 둔다 — NULL 을 받는 컬럼이고, 담당자 휴대전화번호를 저장소에 커밋할
-- 이유가 없다. 첫 로그인 뒤 내 정보 관리에서 넣는다. 이메일은 임시 비밀번호를 받을
-- 곳이라 비울 수 없다. admin_accounts_email_lower CHECK 때문에 소문자여야 한다.
INSERT INTO "admin_accounts" (
  "login_id", "bp_code_id", "name", "password_hash", "email",
  "role_type_code", "role_group_id",
  "is_password_change_required", "join_path_code", "account_status_code"
)
SELECT
  'whaleadmin', bp."bp_code_id", '플랫폼 관리자',
  '!', 'rjy1537@interplug.co.kr',
  'PM', rg."role_group_id",
  true, 'PLATFORM_REGISTERED', 'ACTIVE'
FROM "bp_codes" AS bp, "role_groups" AS rg
WHERE bp."bp_code" = 'BP000000' AND rg."role_code" = 'PM000001';


-- ── 약관 버전 6건 ──
-- 약관 유형마다 한 건. terms_versions 는 (약관 유형, 버전) 이 고유하고 is_active 로
-- 현재 적용 중인 버전을 가린다. 여섯 유형 모두 동의를 받을 수 있어야 하므로 유형이
-- 빠지면 그 약관은 화면에 뜨지 않는다 — 오류 없이 조용히 일어나는 일이다.
--
-- 본문은 Manyfast 기능명세서 「약관 콘텐츠」(F-OFBCVL) 아래 6개 명세의 내용이다
-- (S-BXQKUW · S-SBRAPD · S-NMFIOQ · S-YGOKFJ · S-YLLRWY · S-RTOFHP).
-- 여섯 본문 모두 법무 검토 전이고, 각괄호 [ ] 는 명세에서 아직 안 정한 값이다.
--
-- 시행일은 서비스 오픈일 2026-10-01 이다. 명세(Ⅱ-5)는 "서비스 오픈일" 이라고만 적어 둔다.
--
-- 문구가 바뀌면 이 행을 고치지 않고 같은 유형에 새 버전을 쌓은 뒤 이전 버전의
-- is_active 를 내린다 — 동의 이력이 가리키는 버전은 그대로 남아야 한다.
INSERT INTO "terms_versions" ("terms_type_code", "version", "title", "content", "effective_date", "is_active")
SELECT x.terms_type_code, x.version, x.title, x.content, DATE '2026-10-01', true
FROM (VALUES
  ('TERMS_SERVICE', 'v1.0', '이용약관(BP 사업자 회원가입용)', $terms$# 웨일ERP 이용약관

주식회사 인터플러그가 제공하는 웨일ERP 서비스의 이용과 관련해 회사와 회원(BP)
사이의 권리·의무·책임사항을 정한다.

- 제1조 목적 — 회사와 회원 사이 서비스 이용에 관한 권리·의무·책임사항을 정한다.
- 제2조 정의 — 서비스, 회원, BP, BP 마스터, 이용자, 계정, 회원 데이터를 정의한다.
- 제3조 약관의 게시와 개정 — 개정 적용일 7일 전 공지, 불리한 개정은 30일 전 공지와 개별 통지를 규정한다.
- 제4조 이용계약의 성립 — 약관·개인정보 동의 후 가입 신청과 승낙으로 성립하고, 대리 등록 계정은 최초 로그인 동의로 효력이 생긴다.
- 제5조 회원 정보의 변경 — 정보가 바뀌면 지체 없이 고칠 의무를 규정한다.
- 제6조 회사의 의무 — 법령 준수, 보안 체계, 불만 처리 의무를 규정한다.
- 제7조 회원과 이용자의 의무 — 계정 관리 책임, 제3자 개인정보 입력 시 법적 근거 확보 의무, 금지행위를 규정한다.
- 제8조 서비스의 제공과 변경 — 연중무휴 제공 원칙과 중대한 변경의 7일 전 공지를 규정한다.
- 제9조 서비스의 중단 — 불가항력 등에 의한 일시 중단과 사전·사후 공지를 규정한다.
- 제10조 이용 요금 — 요금표 게시, 무료에서 유료로 바뀔 때 30일 전 공지와 개별 통지, 해지권을 규정한다. 요금체계는 미확정이다.
- 제11조 이용 제한 — 위반 시 경고 → 일시정지 → 해지의 단계적 제한과 이의제기권을 규정한다.
- 제12조 계약 해지 — BP 마스터의 MY PAGE 회원탈퇴와 회사의 해지 사유를 규정한다.
- 제13조 회원 데이터의 소유와 처리 — 회원 데이터는 회원에게 귀속하고, 개인정보는 회사가 수탁자로서 처리하며, 해지 후 [30]일 안에 내려받은 뒤 파기한다.
- 제14조 개인정보 처리위탁 — 직원 등 이용자의 개인정보를 회원의 위탁으로 처리함을 밝히고, 위탁업무 범위(근태·근무스케줄·급여명세서 등 인사 정보 처리), 목적외 이용·제3자 제공 금지, 재위탁 제한, 안전성 확보조치, 손해배상 책임을 규정한다(개인정보보호법 제26조).
- 제15조 개인정보 보호 — 개인정보처리방침에 따른 보호를 규정한다.
- 제16조 지식재산권 — 서비스 관련 지식재산권은 회사에 귀속한다.
- 제17조 손해배상 — 고의·중과실 외에는 직전 [12]개월 이용요금 합계를 배상 한도로 한다.
- 제18조 면책 — 불가항력, 귀책사유, 입력 오류, 제3자 서비스 장애, 분쟁 등 다섯 가지 면책 사유를 규정한다.
- 제19조 통지 — 등록 이메일과 앱 알림으로 통지하고, 전체 공지는 7일 게시로 갈음한다.
- 제20조 양도 금지 — 계약상 지위·권리의무의 제3자 양도와 담보 제공을 금지한다.
- 제21조 분리 가능성 — 일부가 무효여도 나머지 조항의 효력은 유지된다.
- 제22조 준거법과 관할 — 대한민국 법률과 민사소송법상 관할을 따른다.
- 제23조 문의 — 고객센터 이메일과 전화번호를 안내한다.
- 부칙 — 시행일을 밝힌다.

손해배상 한도(직전 [12]개월 이용요금 합계), 해지 후 데이터 내려받기 기간([30]일),
고객센터 연락처는 법무 검토 전 잠정값이다.$terms$),
  ('PRIVACY_COLLECT', 'v1.0', '개인정보 수집·이용 동의(BP 사업자 회원가입용)', $terms$# 개인정보 수집 및 이용 동의 (BP 사업자 회원가입용)

BP 회원가입에서 수집하는 개인정보의 항목·목적·보유기간과 동의를 거부할 때의
불이익을 알린다.

## 수집 목적별 항목과 보유기간

| 목적 | 항목 | 보유기간 |
|---|---|---|
| 회원가입·본인확인 | 아이디, 비밀번호, 이름, 휴대전화번호, 이메일 | 회원탈퇴 시까지(탈퇴 즉시 파기) |
| 고객문의·상담이력 | 이름, 연락처, 문의내용 | 처리완료 후 [3]년 |
| 서비스 부정이용 방지 | 접속로그, 이용기록 | 수집일로부터 [1]년 |
| 마케팅·공지사항 안내(동의 시에만) | 이름, 연락처 | 동의 철회 시까지 |

## 사업자정보 인증

사업자등록번호·상호·대표자명·개업일자를 국세청 API 로 조회해 추가로 수집하며,
보유기간은 탈퇴 즉시 파기를 원칙으로 한다. 선택 입력 항목(대표자 연락처 등)은
입력한 경우에만 수집한다.

탈퇴 완료 안내 메일의 발송 기록(수신 이메일 포함)은 발송일로부터 1년 보관한 뒤
파기한다.

## 법령에 따른 보존

전자상거래법에 따라 계약·청약철회 기록 5년, 대금결제와 재화 공급에 관한 기록
5년, 소비자 불만·분쟁처리 기록 3년을 보관하고, 통신비밀보호법에 따라 보안로그를
3개월 보관한다.

## 동의를 거부할 권리

필수 항목 동의를 거부하면 BP 회원가입을 끝낼 수 없다. 사업자정보 인증(선택)을
거부해도 회원가입은 되지만, 점포를 운영 상태로 바꾸는 등 인증이 필요한 기능은
쓸 수 없다.

개인정보 보호책임자 연락처(전화·이메일)는 법무 검토에서 확정한다.$terms$),
  ('STAFF_TERMS_SERVICE', 'v1.0', '이용약관(직원 근무 앱 회원가입용)', $terms$# 웨일ERP 직원 근무 앱 이용약관

직원이 웨일ERP 직원 근무 앱에 가입할 때 받는 이용약관이다. BP 사업자용 약관과
같은 회사·같은 서비스를 규정하지만, 받는 대상이 사업자가 아니라 개인인 직원이다.

- 제1조 목적 — 회사와 직원 사이 근무 앱 이용에 관한 권리·의무·책임사항을 정한다.
- 제2조 정의 — 근무 앱, 소속 사업장(BP), 직원(소속 종료 후 계정 유지자 포함), 계정, 직원 데이터, 소속 사업장 관리자를 정의한다.
- 제3조 개정 — 적용일 7일 전 공지, 불리하거나 권리·의무에 중대한 영향을 주는 개정은 30일 전 공지와 개별 통지를 규정하며, 거부하지 않으면 동의로 보는 의제동의와 직원의 거부·해지권을 함께 규정한다.
- 제4조 이용계약의 성립 및 소속 관리 — 소속 사업장 초대를 받은 사람이 약관에 동의하고 회사가 가입을 승인하면 성립한다. 직원 계정은 만 19세 이상만 만들 수 있고, 미성년은 가입이 제한되며 근무관리는 소속 사업장이 근무 앱 밖에서 처리한다. 소속·이용권한은 소속 사업장 관리자가 관리하고, 소속을 더하거나 바꾸는 것만으로 이전 사업장의 업무기록이 새 사업장에 제공되지 않는다.
- 제5조 계정관리 및 직원의 의무 — 계정·인증정보 관리 책임과 허위 정보 입력 금지를 규정한다.
- 제6조 회사의 의무 — 법령 준수, 직원 데이터 보호 의무, 접근 권한 관리를 규정한다.
- 제7조 서비스의 제공과 변경 — 쓸 수 있는 기능은 소속 사업장의 서비스 이용범위·권한에 따라 달라질 수 있고, 근태·스케줄편성·급여산정 등 인사·노무 사항은 소속 사업장이 담당하며 시스템 오류 등만 회사가 처리한다.
- 제8조 서비스의 중단 — 계획된 중단은 사유·예정시간·영향 기능을 미리 공지한다.
- 제9조 이용 제한 — 위반 시 경고 → 일시정지 → 해지의 단계적 제한과 이의제기 절차, 소속 종료 시 접근권한 종료를 규정한다.
- 제10조 이용계약의 해지 및 소속 종료 — 회원탈퇴와 소속종료를 구분하고, 탈퇴하지 않은 계정은 보유기준에 따라 유지하며 다른 소속을 다시 받을 수 있다.
- 제11조 직원 데이터 및 개인정보의 처리 — 회사가 직접 처리하는 개인정보와 소속 사업장에서 위탁받아 처리하는 개인정보를 구분해 관리하며, 위탁범위를 넘는 이용과 제3자 제공을 금지하고 권리행사 절차를 규정한다.
- 제12조 지식재산권 — 근무 앱 관련 지식재산권은 회사에 귀속한다.
- 제13조 손해배상 및 책임 — 서로의 위반에 따른 손해배상과 불가항력·귀책사유 면책을 규정한다.
- 제14조 통지 — 이메일·휴대전화번호·앱 알림으로 통지하고, 권리·의무에 중대한 사항은 개별 통지한다.
- 제15조 분쟁해결 및 관할법원 — 대한민국 법률과 민사소송법상 관할을 따른다.
- 부칙 — 시행일을 밝힌다.$terms$),
  ('STAFF_PRIVACY', 'v1.0', '개인정보 수집·이용 동의(직원 근무 앱 회원가입용)', $terms$# 개인정보 수집·이용 동의 (직원 근무 앱 가입용)

관리자가 등록한 직원 개인정보를 그 직원 본인이 근무 앱 가입(초대 수락) 때 직접
동의하는 문서다. BP 사업자용 동의와는 받는 대상과 수집 항목이 전혀 다르다.

## 수집 목적별 항목과 보유기간

| 목적 | 항목 | 보유기간 |
|---|---|---|
| 계정생성·본인확인·로그인 | 이름, 휴대전화번호, 이메일 | 회원탈퇴 시까지 |
| 근로계약 체결·이력관리 | 생년월일, 계약조건(급여형태·소정근로시간·주휴일·임금지급일·4대보험 가입여부), 전자서명 | 퇴직일로부터 [3]년 |
| 출퇴근·근태관리 | 출퇴근시각, 위치판정결과(좌표는 저장하지 않음) | 근로기준법상 [3]년 |
| 근무스케줄·TO-DO 확인 | 배정내역 | 생성일로부터 [3]년 |
| 급여명세서 확인 | 지급·공제내역 | 임금대장 보존기준 [3]년 |

## 법령에 따른 별도 수집 — 주민등록번호

이 동의와 별개로, 직원 근무 앱의 4대보험·급여 신고정보 단계에서 직원 본인이
직접 입력한다. 개인정보보호법 제24조의2에 따라 동의 없이 목적만 알리며,
관리자 화면에는 마스킹만 보이고 저장은 암호화한다.

급여 계좌는 같은 신고정보 화면에서 받지만, 수집 근거가 근로계약 이행(임금 지급)
이라 주민등록번호와 다르다.

## 제공하지 않는 것

소속 사업장이 직원 자료를 내려받아도 주민등록번호·4대보험 신고정보·위치정보
확인자료·약관 동의 기록은 들어가지 않는다. 가맹 점포 직원의 본사 제공 동의,
마케팅 수신 동의, 위치정보 동의는 이 문서에 넣지 않고 각각 따로 받는다.

## 동의를 거부할 권리

이 동의는 근무 앱 기본 기능(근태·근무스케줄·급여명세서 확인)을 쓰는 데 필요한
필수 항목이라, 거부하면 근무 앱 가입과 이용이 제한된다. 주민등록번호를 넣지
않으면 4대보험 취득신고 등 관련 절차를 진행할 수 없다.$terms$),
  ('MARKETING', 'v1.0', '마케팅 수신 동의', $terms$# 마케팅 수신을 위한 개인정보 이용 동의 [선택]

- 수집목적 — 신규기능·이벤트·혜택 안내, 만족도조사.
- 수집항목 — 이름, 휴대전화번호, 이메일, 앱 푸시 알림 토큰.
- 보유기간 — 직원계정 삭제 또는 동의 철회 시까지.
- 수신채널 — 앱푸시·문자·이메일 각각을 골라 동의할 수 있다.

## 동의를 거부할 권리

동의하지 않거나 나중에 철회해도 근무 앱 이용에 제한이 없다.

## 철회와 재확인

2년마다 수신동의 상태를 다시 확인하며, 야간(21시~08시)에는 마케팅 메시지를
보내지 않는다.

소속 사업장에게는 직원의 마케팅 동의 여부를 제공하지 않으며, 근무·교대 등 업무
알림은 이 동의와 별개로 보낸다.$terms$),
  ('LOCATION', 'v1.0', '위치정보 수집·이용 동의', $terms$# 위치정보 수집·이용 동의 [필수]

GPS 출퇴근을 쓰려면 동의가 필요하다. 첫 출퇴근 등록 시점에 받는다.

## 수집항목과 목적

| 항목 | 목적 | 보유기간 |
|---|---|---|
| 출퇴근 판정용 GPS 좌표 | 출퇴근 판정 | 판정 직후 파기 — 좌표 자체는 저장하지 않는다 |
| 출퇴근 판정결과와 오차 | 근태 기록 | 근로기준법상 기록보관 기간인 3년 |

## 수집방법과 시점

출퇴근 버튼을 누를 때만 한 번 수집하며, 상시 위치추적은 하지 않는다. 판정
반경은 기본 100m 다. 이용제공사실 확인자료는 따로 6개월 보관한다.

## 판정결과의 제공

관리자에게는 출퇴근 판정결과만 보이고, 원본 GPS 좌표는 제공하지 않는다.

## 동의를 거부할 권리

동의를 거부하면 GPS 출퇴근 등록을 진행할 수 없다. 대체 출퇴근 수단은 미확정이다.

사업자정보(주소·책임자·연락처)는 법무 검토에서 확정한다.$terms$)
) AS x(terms_type_code, version, title, content);
-- ── 건수 검사 ──
-- 파일이 잘려 들어가거나 VALUES 한 줄이 빠지면 여기서 멈춘다. 마이그레이션은
-- 한 트랜잭션이라 실패하면 위의 INSERT 도 함께 되돌아간다.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM "code_groups";
  IF n <> 12 THEN RAISE EXCEPTION '공통코드 그룹이 12건이어야 하는데 %건이다', n; END IF;

  SELECT count(*) INTO n FROM "code_items";
  IF n <> 52 THEN RAISE EXCEPTION '상세 코드가 52건이어야 하는데 %건이다', n; END IF;

  SELECT count(*) INTO n FROM "menus";
  IF n <> 64 THEN RAISE EXCEPTION '메뉴가 64건이어야 하는데 %건이다', n; END IF;

  SELECT count(*) INTO n FROM "menus" WHERE "parent_menu_id" IS NOT NULL;
  IF n <> 49 THEN RAISE EXCEPTION '상위 메뉴 연결이 49건이어야 하는데 %건이다', n; END IF;

  SELECT count(*) INTO n FROM "role_groups";
  IF n <> 3 THEN RAISE EXCEPTION '권한 그룹이 3건이어야 하는데 %건이다', n; END IF;

  SELECT count(*) INTO n FROM "role_group_menus";
  IF n <> 106 THEN RAISE EXCEPTION '메뉴 권한이 106건이어야 하는데 %건이다', n; END IF;

  SELECT count(*) INTO n FROM "admin_accounts";
  IF n <> 1 THEN RAISE EXCEPTION '플랫폼 마스터가 1건이어야 하는데 %건이다', n; END IF;

  -- 이 마이그레이션이 쓸 수 있는 비밀번호를 넣지 않았는지. 누군가 나중에 실제
  -- 해시를 적어 커밋하면 여기서 멈춘다 — 비밀번호는 git 이 아니라 임시 비밀번호
  -- 발급으로 들어가야 한다.
  SELECT count(*) INTO n FROM "admin_accounts" WHERE "password_hash" <> '!';
  IF n <> 0 THEN RAISE EXCEPTION '플랫폼 마스터에 쓸 수 있는 비밀번호가 들어갔다 — 임시 비밀번호 발급으로 받아야 한다'; END IF;

  SELECT count(*) INTO n FROM "terms_versions";
  IF n <> 6 THEN RAISE EXCEPTION '약관 버전이 6건이어야 하는데 %건이다', n; END IF;

  -- 여섯 유형이 모두 공통코드 TERMS_TYPE 에 있는 값인지. 코드값이라 FK 가 없어
  -- DB 가 막아 주지 않는다 — 오타가 들어가면 그 약관만 조용히 안 뜬다.
  SELECT count(*) INTO n
  FROM "terms_versions" t
  WHERE NOT EXISTS (
    SELECT 1 FROM "code_items" c
    WHERE c."group_code" = 'TERMS_TYPE' AND c."item_code" = t."terms_type_code"
  );
  IF n <> 0 THEN RAISE EXCEPTION '공통코드 TERMS_TYPE 에 없는 약관 유형이 %건이다', n; END IF;
END $$;
