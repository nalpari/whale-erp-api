-- 기본 템플릿 PUSH_TODO_ASSIGNED(TO-DO 배정)를 PUSH_TODO_DUE_SOON(TO-DO 수행 임박 알림)으로 바꾼다 (2026-10-19 재영, api #115,
-- 용어집 「수행 임박 알림」). TO-DO 배정 알림은 없어졌고, 수행 예정 일시가 다가오면 배정된 직원에게 한 번 보낸다.
--
-- 같은 행을 고친다 — 템플릿 ID 가 그대로라 기본 템플릿 40건 셈과 되돌리기 원본이 이어진다. 바꾸는 칸은 템플릿 코드 ·
-- 이름 · 제목과 되돌리기 원본 제목(default_title)이다. 본문 「#{TO-DO제목} · #{수행예정일시}」 · 변수 목록 · 수신 설정 묶음
-- TODO 는 같아 그대로 둔다. 운영 전이라 마이그레이션으로 고친다(20261015155556 과 같다). 변경 이력은 남기지 않는다.
-- 이 템플릿으로 만든 알림은 아직 없다(배정 알림을 만드는 코드가 없었다). 발송 코드(TodoDueSoonService)는 새 코드로 부른다 —
-- 이 파일이 적용되기 전에는 템플릿이 없어 수행 임박 알림만 만들지 않는다(서버 로그 todo due soon SKIPPED).

UPDATE "notification_templates"
   SET "template_code" = 'PUSH_TODO_DUE_SOON',
       "template_name" = 'TO-DO 수행 임박 알림',
       "title" = '곧 수행할 TO-DO가 있습니다',
       "default_title" = '곧 수행할 TO-DO가 있습니다',
       "updated_at" = now()
 WHERE "template_code" = 'PUSH_TODO_ASSIGNED';

-- 검증은 이번에 바꾼 칸만 본다 — 본문 · 변수는 템플릿 관리 화면에서 고칠 수 있어 넣으면 누가 고친 DB 에서 deploy 가 멈춘다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'PUSH_TODO_DUE_SOON' AND "channel" = 'PUSH' AND "preference_category" = 'TODO'
     AND "template_name" = 'TO-DO 수행 임박 알림'
     AND "title" = '곧 수행할 TO-DO가 있습니다' AND "default_title" = "title";
  IF n <> 1 THEN
    RAISE EXCEPTION 'PUSH_TODO_DUE_SOON 으로 바뀌지 않았다: %', n;
  END IF;
  SELECT count(*) INTO n FROM "notification_templates" WHERE "template_code" = 'PUSH_TODO_ASSIGNED';
  IF n <> 0 THEN
    RAISE EXCEPTION 'PUSH_TODO_ASSIGNED 가 남아 있다: %', n;
  END IF;
END $$;
