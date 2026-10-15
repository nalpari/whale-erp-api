-- 고객지원을 공지사항 · FAQ · 문의하기 세 메뉴, 한 단계 경로로 나눈다 (WHALEERP-596, 2026-10-15 재영 A안)
-- #594(20261015110333_team3_menu_single_level_urls)에서 빠진 것. 목업 SUPPORT-4 의 「/support 한 화면에 탭 셋, LNB 는
-- 해시」로는 front 의 메뉴 권한 판정(isAllowed, 경로만 본다)이 메뉴와 화면을 잇지 못하고, FAQ 는 메뉴 행이 없었다.
-- 1팀 마이그레이션은 고치지 않고 여기서 덮는다.

-- 1. FAQ 메뉴를 새로 둔다. 코드는 WHALE_ERP 다음 번호(MN000043), 권한은 공지사항(MN000035)과 같게 준다.
INSERT INTO "menus" ("menu_code", "service_code", "parent_menu_id", "name", "url", "sort_order", "depth", "status")
SELECT 'MN000043', 'WHALE_ERP', p."menu_id", 'FAQ', '/support-faqs', 2, 2, 'ACTIVE'
  FROM "menus" p
 WHERE p."menu_code" = 'MN000034';

INSERT INTO "role_group_menus" ("role_group_id", "menu_id", "is_readable", "is_creatable", "is_updatable", "is_deletable")
SELECT r."role_group_id", f."menu_id", r."is_readable", r."is_creatable", r."is_updatable", r."is_deletable"
  FROM "role_group_menus" r
  JOIN "menus" n ON n."menu_id" = r."menu_id" AND n."menu_code" = 'MN000035'
  JOIN "menus" f ON f."menu_code" = 'MN000043'
 WHERE NOT r."is_deleted";

-- 2. url · 순서. 공지사항 · FAQ · 문의하기 순으로 두고, 사용중지 넷(MN000037~040)은 url 을 두고 뒤로 민다.
UPDATE "menus" m SET "url" = COALESCE(v.url, m."url"), "sort_order" = v.sort_order, "updated_at" = CURRENT_TIMESTAMP
  FROM (VALUES
    ('MN000035', '/support-notices', 1),
    ('MN000036', '/support-inquiries', 3),
    ('MN000037', NULL, 4),
    ('MN000038', NULL, 5),
    ('MN000039', NULL, 6),
    ('MN000040', NULL, 7)
  ) AS v(code, url, sort_order)
 WHERE m."menu_code" = v.code;

DO $$
BEGIN
  IF (SELECT count(*) FROM "menus" c JOIN "menus" p ON p."menu_id" = c."parent_menu_id" AND p."menu_code" = 'MN000034'
       WHERE NOT c."is_deleted" AND c."status" = 'ACTIVE'
         AND (c."menu_code", c."url", c."sort_order") IN (
           ('MN000035', '/support-notices', 1), ('MN000043', '/support-faqs', 2), ('MN000036', '/support-inquiries', 3))) <> 3 THEN
    RAISE EXCEPTION '고객지원 메뉴 셋이 바뀌지 않았다';
  END IF;
  IF (SELECT count(*) FROM "role_group_menus" WHERE "menu_id" = (SELECT "menu_id" FROM "menus" WHERE "menu_code" = 'MN000043') AND NOT "is_deleted")
     <> (SELECT count(*) FROM "role_group_menus" WHERE "menu_id" = (SELECT "menu_id" FROM "menus" WHERE "menu_code" = 'MN000035') AND NOT "is_deleted") THEN
    RAISE EXCEPTION 'FAQ 권한이 공지사항과 다르다';
  END IF;
  -- 다른 메뉴 url 아래에 놓이거나 아래에 다른 메뉴를 두면 isAllowed 가 상위 권한으로 하위를 연다. 이번 셋만 본다.
  IF EXISTS (SELECT 1 FROM "menus" a JOIN "menus" b ON a."service_code" = b."service_code" AND a."menu_id" <> b."menu_id"
              WHERE NOT a."is_deleted" AND NOT b."is_deleted" AND b."url" LIKE a."url" || '/%'
                AND (a."menu_code" IN ('MN000035', 'MN000036', 'MN000043')
                  OR b."menu_code" IN ('MN000035', 'MN000036', 'MN000043'))) THEN
    RAISE EXCEPTION '겹치는 메뉴 url 이 있다';
  END IF;
END $$;
