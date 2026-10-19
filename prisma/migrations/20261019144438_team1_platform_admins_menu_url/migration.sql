-- 플랫폼 관리자 관리(MN000213)의 url 을 한 단계 경로로 바꾼다 — /platform/system/admins → /platform-admins (2026-10-19).
-- 관리자 웹 화면 주소를 API 자원 이름과 같게 맞추고, 메뉴 url 은 1뎁스만 받는다(플랫폼 메뉴 관리). 관리자 웹은 login-info 의
-- 이 url 로 메뉴를 그리고 화면 권한을 판정하므로 front 라우트와 함께 바뀌어야 한다. 1팀 메뉴 이 한 줄만 바꾸고, 적용된
-- 초기 데이터(20261006000100_team1_initial_data)는 고치지 않고 여기서 덮는다.
UPDATE "menus" SET "url" = '/platform-admins', "updated_at" = CURRENT_TIMESTAMP
 WHERE "menu_code" = 'MN000213' AND NOT "is_deleted";

DO $$
BEGIN
  IF (SELECT count(*) FROM "menus" WHERE "menu_code" = 'MN000213' AND "url" = '/platform-admins' AND NOT "is_deleted") <> 1 THEN
    RAISE EXCEPTION 'MN000213 url 이 바뀌지 않았다';
  END IF;
  -- 같거나 한쪽이 다른 쪽 아래인 url 이면 관리자 웹의 접두어 판정이 한 메뉴의 권한으로 다른 화면을 연다. 이 메뉴만 본다.
  IF EXISTS (SELECT 1 FROM "menus" m
              WHERE m."menu_code" <> 'MN000213' AND NOT m."is_deleted" AND m."status" = 'ACTIVE'
                AND (m."url" = '/platform-admins' OR m."url" LIKE '/platform-admins/%' OR '/platform-admins' LIKE m."url" || '/%')) THEN
    RAISE EXCEPTION '/platform-admins 와 겹치는 사용 중 메뉴 url 이 있다';
  END IF;
END $$;
