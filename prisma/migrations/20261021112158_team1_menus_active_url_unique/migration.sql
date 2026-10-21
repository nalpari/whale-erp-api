-- 사용 중 메뉴의 url 을 DB 에서도 유일하게 한다 (2026-10-21). `@MenuPermission` 가드가 컨트롤러 경로의 첫 단계를
-- menus.url 로 찾으므로(메뉴 코드 대신 url 이 API 권한 키다) 같은 url 의 사용 중 메뉴가 둘이면 한 API 가 두 메뉴의 권한
-- 중 아무것으로나 열린다. 플랫폼 메뉴 관리가 저장할 때 막지만(assertUrlFree — 같거나 접두어로 겹치면 409) 앱 검증은
-- 마이그레이션 · 직접 SQL 이 넣는 중복을 막지 못하므로 부분 유니크 인덱스를 둔다.
--
-- 사용중지 · 지운 메뉴는 권한 판정에 쓰이지 않아(가드는 사용 중 · 지우지 않은 메뉴만 본다) 같은 url 을 들고 있어도 된다.
-- 접두어 겹침(/a 와 /a/b)은 인덱스로 표현되지 않아 여전히 앱이 막는다. Prisma 스키마 언어는 부분 인덱스를 표현하지
-- 못해 schema.prisma 에는 없고 이 SQL 에만 있다(db:pull 이 지운다).

-- 이미 겹치는 행이 있으면 인덱스 생성 오류 대신 어느 url 인지 알려 주고 멈춘다.
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(url, ', ' ORDER BY url) INTO dup
    FROM (SELECT "url" AS url FROM "menus"
           WHERE NOT "is_deleted" AND "status" = 'ACTIVE'::"use_status" AND "url" IS NOT NULL
           GROUP BY "url" HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '사용 중 메뉴의 url 이 겹친다: % — 한쪽을 사용중지하거나 url 을 바꾼 뒤 다시 적용한다', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "menus_url_active_key" ON "menus" ("url")
  WHERE NOT "is_deleted" AND "status" = 'ACTIVE'::"use_status" AND "url" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = current_schema() AND tablename = 'menus'
                    AND indexname = 'menus_url_active_key'
                    AND indexdef LIKE 'CREATE UNIQUE INDEX%') THEN
    RAISE EXCEPTION '부분 유니크 인덱스 menus_url_active_key 가 생기지 않았다';
  END IF;
END $$;
