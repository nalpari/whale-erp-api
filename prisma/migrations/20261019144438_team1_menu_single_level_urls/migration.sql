-- 1팀 메뉴 10개의 url 을 한 단계 경로로 바꾼다 (2026-10-19). 관리자 웹 화면 주소를 API 자원 이름에 맞추고, 메뉴 url 은
-- 1뎁스만 받는다(플랫폼 메뉴 관리). 관리자 웹은 login-info 의 이 url 로 메뉴를 그리고 화면 권한을 판정하므로 front 라우트와
-- 함께 바뀌어야 한다. 1팀이 작업하는 사용 중 메뉴만 바꾸고, 3팀 메뉴(플랫폼 커뮤니티 공지사항 · FAQ · 문의사항 · 도입문의)와
-- 사용중지 메뉴는 그대로 둔다. 적용된 초기 데이터(20261006000100_team1_initial_data)는 고치지 않고 여기서 덮는다.
UPDATE "menus" m SET "url" = v.url, "updated_at" = CURRENT_TIMESTAMP
  FROM (VALUES
    ('MN000203', '/bp-masters'),           -- BP 마스터 계정 관리      /platform/bp
    ('MN000213', '/platform-admins'),      -- 플랫폼 관리자 관리       /platform/system/admins
    ('MN000214', '/platform-role-groups'), -- 플랫폼 권한 관리         /platform/system/roles
    ('MN000215', '/platform-menus'),       -- 플랫폼 메뉴 관리         /platform/system/menus
    ('MN000216', '/code-groups'),          -- 플랫폼 공통코드 관리     /platform/system/codes
    ('MN000217', '/public-holidays'),      -- 플랫폼 휴일 관리         /platform/system/holidays
    ('MN000012', '/bp-admins'),            -- BP 관리자 관리           /settings/admins
    ('MN000013', '/bp-role-groups'),       -- BP 권한 그룹 관리        /settings/roles
    ('MN000014', '/bp-code-groups'),       -- BP 공통코드 관리         /settings/codes
    ('MN000015', '/bp-holidays')           -- BP 휴일 관리             /settings/holidays
  ) AS v(code, url)
 WHERE m."menu_code" = v.code AND NOT m."is_deleted";

DO $$
DECLARE
  codes text[] := ARRAY['MN000203', 'MN000213', 'MN000214', 'MN000215', 'MN000216', 'MN000217',
                        'MN000012', 'MN000013', 'MN000014', 'MN000015'];
BEGIN
  IF (SELECT count(*) FROM "menus" WHERE NOT "is_deleted" AND ("menu_code", "url") IN (
        ('MN000203', '/bp-masters'), ('MN000213', '/platform-admins'), ('MN000214', '/platform-role-groups'),
        ('MN000215', '/platform-menus'), ('MN000216', '/code-groups'), ('MN000217', '/public-holidays'),
        ('MN000012', '/bp-admins'), ('MN000013', '/bp-role-groups'), ('MN000014', '/bp-code-groups'),
        ('MN000015', '/bp-holidays'))) <> 10 THEN
    RAISE EXCEPTION '메뉴 url 10건이 바뀌지 않았다';
  END IF;
  -- 같거나 한쪽이 다른 쪽 아래인 url 이면 관리자 웹의 접두어 판정이 한 메뉴의 권한으로 다른 화면을 연다(플랫폼 메뉴 관리와
  -- 같이 서비스를 가리지 않고 사용 중 메뉴끼리 본다). 이번 10건이 낀 쌍만 본다.
  IF EXISTS (SELECT 1 FROM "menus" a JOIN "menus" b ON a."menu_id" <> b."menu_id"
              WHERE NOT a."is_deleted" AND NOT b."is_deleted" AND a."status" = 'ACTIVE' AND b."status" = 'ACTIVE'
                AND (a."url" = b."url" OR b."url" LIKE a."url" || '/%')
                AND (a."menu_code" = ANY (codes) OR b."menu_code" = ANY (codes))) THEN
    RAISE EXCEPTION '이번에 바꾼 메뉴 url 과 겹치는 사용 중 메뉴 url 이 있다';
  END IF;
END $$;
