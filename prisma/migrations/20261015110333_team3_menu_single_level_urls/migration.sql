-- 3팀 메뉴를 한 단계 경로로 바꾼다 (WHALEERP-594, 2026-10-14 재영 A안 — 메뉴는 1단계만 둔다)
-- /staff 와 /staff/contracts 처럼 url 이 겹치면 front 의 접두어 판정(isAllowed)이 상위 메뉴 조회 권한만으로
-- 하위 화면을 열어 준다. 메뉴는 1팀 표지만 url 은 작업자가 정한다(류제영, 2026-10-14). 1팀 마이그레이션은 고치지 않고 여기서 덮는다.

-- 1. 근로계약 관리(MN000006)가 계약 목록(MN000007)·초안 작성(MN000008)을 대신한다. 근로계약서 초안 작성은 계약 목록의
--    [계약서 작성] 버튼이고 「근로계약 관리」 create 권한으로 보인다. 그래서 셋의 권한을 OR 로 합쳐 MN000006 에 둔다.
INSERT INTO "role_group_menus" ("role_group_id", "menu_id", "is_readable", "is_creatable", "is_updatable", "is_deletable")
SELECT r."role_group_id", p."menu_id", bool_or(r."is_readable"), bool_or(r."is_creatable"), bool_or(r."is_updatable"), bool_or(r."is_deletable")
  FROM "role_group_menus" r
  JOIN "menus" m ON m."menu_id" = r."menu_id" AND m."menu_code" IN ('MN000006', 'MN000007', 'MN000008')
  JOIN "menus" p ON p."menu_code" = 'MN000006'
 WHERE NOT r."is_deleted"
 GROUP BY r."role_group_id", p."menu_id"
ON CONFLICT ("role_group_id", "menu_id") DO UPDATE SET
  "is_readable" = EXCLUDED."is_readable", "is_creatable" = EXCLUDED."is_creatable",
  "is_updatable" = EXCLUDED."is_updatable", "is_deletable" = EXCLUDED."is_deletable",
  "is_deleted" = false, "updated_at" = CURRENT_TIMESTAMP;

-- 2. 3단계 메뉴 둘을 지운다. 권한 행이 메뉴를 가리키므로(ON DELETE RESTRICT) 권한부터.
DELETE FROM "role_group_menus" WHERE "menu_id" IN (SELECT "menu_id" FROM "menus" WHERE "menu_code" IN ('MN000007', 'MN000008'));
DELETE FROM "menus" WHERE "menu_code" IN ('MN000007', 'MN000008');

-- 3. url. 알림함(MN000042) /notifications 는 그대로다.
UPDATE "menus" m SET "url" = v.url, "updated_at" = CURRENT_TIMESTAMP
  FROM (VALUES
    ('MN000005', '/staff-members'),
    ('MN000006', '/contracts'),
    ('MN000009', '/payslips'),
    ('MN000010', '/work-schedules'),
    ('MN000025', '/attendance-records'),
    ('MN000026', '/todos')
  ) AS v(code, url)
 WHERE m."menu_code" = v.code;

DO $$
BEGIN
  IF (SELECT count(*) FROM "menus" WHERE "menu_code" IN ('MN000007', 'MN000008')) <> 0 THEN
    RAISE EXCEPTION '3단계 메뉴가 남았다';
  END IF;
  IF (SELECT count(*) FROM "menus" WHERE ("menu_code", "url") IN (
        ('MN000005', '/staff-members'), ('MN000006', '/contracts'), ('MN000009', '/payslips'),
        ('MN000010', '/work-schedules'), ('MN000025', '/attendance-records'), ('MN000026', '/todos'))) <> 6 THEN
    RAISE EXCEPTION '메뉴 url 6건이 바뀌지 않았다';
  END IF;
  -- 다른 메뉴 url 아래에 놓이거나 아래에 다른 메뉴를 두면 isAllowed 가 상위 권한으로 하위를 연다. 이번 6건만 본다
  -- (/stores 아래 1팀 메뉴의 겹침은 1팀 몫이다).
  IF EXISTS (SELECT 1 FROM "menus" a JOIN "menus" b ON a."service_code" = b."service_code" AND a."menu_id" <> b."menu_id"
              WHERE NOT a."is_deleted" AND NOT b."is_deleted" AND b."url" LIKE a."url" || '/%'
                AND (a."menu_code" IN ('MN000005', 'MN000006', 'MN000009', 'MN000010', 'MN000025', 'MN000026')
                  OR b."menu_code" IN ('MN000005', 'MN000006', 'MN000009', 'MN000010', 'MN000025', 'MN000026'))) THEN
    RAISE EXCEPTION '겹치는 메뉴 url 이 있다';
  END IF;
END $$;
