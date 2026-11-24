-- 근무스케줄 알림 · 메일 문구를 등록에도 맞게 바꾼다 (WHALEERP-769, 2026-11-24).
--
-- work-schedule-notice.ts 는 등록 · 수정 · 삭제에 같은 템플릿을 쓰는데, 처음 등록해도 「근무스케줄 변경 / … 변경되었습니다」로 갔다.
-- PUSH_SCHEDULE_CHANGED(20261030093710) · EMAIL_SCHEDULE_CHANGED(20261030142820)의 제목 · 본문만 바꾼다. 메일 제목의
-- [WHALE ERP] 머리는 그대로 두고, 메일 HTML 틀(버튼 포함)은 발송 코드가 붙이므로 본문은 앱 푸시와 같은 글이다.
-- 템플릿 코드 · 이름 · 채널 · 수신 설정 묶음 · 변수 목록 · 사용 여부 · 발송 로직은 그대로다.
--
-- 운영자가 이미 고친 문구는 덮어쓰지 않는다 — 제목 · 본문이 둘 다 옛 기본값 그대로일 때만 바꾼다(변수 목록은 바꾸지 않으니
-- 보지 않는다). 되돌리기 원본(default_*)은 늘 새 문구로 — 「기본값으로 되돌리기」가 새 문구가 된다. 되돌리기 원본만 바꾸는
-- UPDATE 는 updated_at 을 올리지 않는다(20261109165622 와 같다 — 수정 화면의 낙관적 잠금 값이라, 고친 템플릿을 열어 둔 채 배포되면
-- 저장이 409 가 된다). 검증이 실패하면 UPDATE 도 되돌리도록 한 트랜잭션으로 묶는다(Prisma 는 마이그레이션을 감싸지 않는다).

BEGIN;

CREATE TEMP TABLE "_schedule_notice_wording" ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('PUSH_SCHEDULE_CHANGED', $t$근무스케줄 변경$t$, $t$근무스케줄 안내$t$),
  ('EMAIL_SCHEDULE_CHANGED', $t$[WHALE ERP] 근무스케줄 변경$t$, $t$[WHALE ERP] 근무스케줄 안내$t$)
) AS v("template_code", "title_from", "title_to");

-- 두 템플릿 모두 되돌리기 원본이 옛 문구여야 한다 — 아니면 멈춘다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r
    JOIN "_schedule_notice_wording" AS w ON w."template_code" = r."template_code"
   WHERE r."default_title" = w."title_from"
     AND r."default_body" = $t$#{근무지} 근무스케줄이 변경되었습니다.

- 변경 내용: #{변경내용}

직원 근무 앱에서 바뀐 스케줄을 확인해 주세요.$t$;
  IF n <> 2 THEN
    RAISE EXCEPTION '문구를 바꿀 근무스케줄 템플릿 2건의 기본 문구가 옛 문구가 아니다: %', n;
  END IF;
END $$;

-- 지금 값: 제목 · 본문이 둘 다 되돌리기 원본 그대로일 때만. default_* 를 바꾸기 전에 비교한다.
UPDATE "notification_templates" AS r
   SET "title" = w."title_to", "body" = $t$#{근무지} 근무스케줄이 등록 · 변경되었습니다.

- 내용: #{변경내용}

직원 근무 앱에서 근무스케줄을 확인해 주세요.$t$, "updated_at" = now()
  FROM "_schedule_notice_wording" AS w
 WHERE r."template_code" = w."template_code"
   AND r."title" = r."default_title" AND r."body" = r."default_body";

-- 되돌리기 원본: 2건 모두. updated_at 은 올리지 않는다(머리 주석).
UPDATE "notification_templates" AS r
   SET "default_title" = w."title_to", "default_body" = $t$#{근무지} 근무스케줄이 등록 · 변경되었습니다.

- 내용: #{변경내용}

직원 근무 앱에서 근무스케줄을 확인해 주세요.$t$
  FROM "_schedule_notice_wording" AS w
 WHERE r."template_code" = w."template_code";

-- 검증은 되돌리기 원본만 본다 — 지금 값은 운영자가 고쳤을 수 있다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r
    JOIN "_schedule_notice_wording" AS w ON w."template_code" = r."template_code"
   WHERE r."default_title" = w."title_to"
     AND r."default_body" = $t$#{근무지} 근무스케줄이 등록 · 변경되었습니다.

- 내용: #{변경내용}

직원 근무 앱에서 근무스케줄을 확인해 주세요.$t$;
  IF n <> 2 THEN
    RAISE EXCEPTION '근무스케줄 템플릿 2건의 기본 문구가 새 문구로 바뀌지 않았다: %', n;
  END IF;
END $$;

COMMIT;
