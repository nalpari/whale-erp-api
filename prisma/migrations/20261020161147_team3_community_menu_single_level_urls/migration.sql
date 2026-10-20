-- 플랫폼 커뮤니티 메뉴 넷의 url 을 한 단계 경로로 바꾼다 (2026-10-20). 1팀 메뉴(20261019144438_team1_menu_single_level_urls)와
-- 같이 관리자 웹 화면 주소를 API 자원 이름에 맞춘다 — 공지사항 · FAQ 는 API 도 /platform-notices · /platform-faqs 로
-- 나눠 메뉴마다 권한을 판정한다. 관리자 웹은 login-info 의 이 url 로 메뉴를 그리고 화면 권한을 판정하므로 front 라우트와
-- 함께 바뀌어야 한다. 적용된 초기 데이터(20261006000100_team1_initial_data)는 고치지 않고 여기서 덮는다.
UPDATE "menus" m SET "url" = v.url, "updated_at" = CURRENT_TIMESTAMP
  FROM (VALUES
    ('MN000219', '/platform-notices'),   -- 공지사항   /platform/community/notices
    ('MN000220', '/platform-faqs'),      -- FAQ        /platform/community/faq
    ('MN000221', '/platform-inquiries'), -- 문의사항   /platform/community/inquiries
    ('MN000222', '/platform-leads')      -- 도입문의   /platform/community/leads
  ) AS v(code, url)
 WHERE m."menu_code" = v.code AND NOT m."is_deleted";

DO $$
DECLARE
  codes text[] := ARRAY['MN000219', 'MN000220', 'MN000221', 'MN000222'];
BEGIN
  IF (SELECT count(*) FROM "menus" WHERE NOT "is_deleted" AND ("menu_code", "url") IN (
        ('MN000219', '/platform-notices'), ('MN000220', '/platform-faqs'),
        ('MN000221', '/platform-inquiries'), ('MN000222', '/platform-leads'))) <> 4 THEN
    RAISE EXCEPTION '메뉴 url 4건이 바뀌지 않았다';
  END IF;
  -- 같거나 한쪽이 다른 쪽 아래인 url 이면 관리자 웹의 접두어 판정이 한 메뉴의 권한으로 다른 화면을 연다. 이번 4건이 낀 쌍만 본다.
  IF EXISTS (SELECT 1 FROM "menus" a JOIN "menus" b ON a."menu_id" <> b."menu_id"
              WHERE NOT a."is_deleted" AND NOT b."is_deleted" AND a."status" = 'ACTIVE' AND b."status" = 'ACTIVE'
                AND (a."url" = b."url" OR b."url" LIKE a."url" || '/%')
                AND (a."menu_code" = ANY (codes) OR b."menu_code" = ANY (codes))) THEN
    RAISE EXCEPTION '이번에 바꾼 메뉴 url 과 겹치는 사용 중 메뉴 url 이 있다';
  END IF;
END $$;
