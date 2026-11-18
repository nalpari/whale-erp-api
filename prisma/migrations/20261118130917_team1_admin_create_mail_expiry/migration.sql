-- 관리자 계정 생성 메일에 임시 비밀번호 사용 기한(1시간)을 적는다(2026-11-18 통합테스트 · 사용자 지정).
--
-- 관리자 초기 비밀번호는 발급 뒤 1시간만 쓸 수 있는데(S-NIMSMQ), BP 관리자 · 플랫폼 관리자 계정 생성 메일에는 그 말이 없었다.
-- 비밀번호 초기화 메일(EMAIL_PASSWORD_RESET)과 같은 문장 「※ 임시 비밀번호는 1시간 동안 유효합니다.」를
-- 「※ 처음 로그인할 때 비밀번호를 변경해 주세요.」 바로 앞에 넣는다. 고정 문구라 발송 코드 · 변수는 그대로다.
--
-- 20261109165622_team3_contract_status_labels 와 같은 방식이다 — 지금 값(title · body · variables)이 셋 다 되돌리기
-- 원본(default_*)과 같을 때만 지금 값을 바꾸고(운영자가 고친 문구는 둔다), 그 다음에 되돌리기 원본을 바꾼다. 변경 이력은 남기지 않는다.

CREATE TEMP TABLE "_admin_create_mail_wording" (
  "template_code" text PRIMARY KEY,
  "body_from" text NOT NULL,
  "body_to" text NOT NULL
);

INSERT INTO "_admin_create_mail_wording" VALUES
  ('EMAIL_BP_ADMIN_CREATE',
   E'\n\n※ 처음 로그인할 때 비밀번호를 변경해 주세요.',
   E'\n\n※ 임시 비밀번호는 1시간 동안 유효합니다.\n※ 처음 로그인할 때 비밀번호를 변경해 주세요.'),
  ('EMAIL_PLAT_ADMIN_CREATE',
   E'\n\n※ 처음 로그인할 때 비밀번호를 변경해 주세요.',
   E'\n\n※ 임시 비밀번호는 1시간 동안 유효합니다.\n※ 처음 로그인할 때 비밀번호를 변경해 주세요.');

-- 되돌리기 원본이 이 파일이 아는 옛 문구 그대로인지 먼저 본다 — 아니면 replace 가 아무것도 바꾸지 않고 지나간다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r
    JOIN "_admin_create_mail_wording" AS w ON w."template_code" = r."template_code"
   WHERE position(w."body_from" IN r."default_body") > 0
     AND position('1시간 동안 유효합니다' IN r."default_body") = 0;
  IF n <> 2 THEN
    RAISE EXCEPTION '사용 기한을 넣을 관리자 계정 생성 메일 2건의 기본 문구가 옛 문구가 아니다: %', n;
  END IF;
END $$;

-- 지금 값: 셋 다 되돌리기 원본 그대로일 때만. default_* 를 바꾸기 전에 비교한다.
UPDATE "notification_templates" AS r
   SET "body" = replace(r."body", w."body_from", w."body_to"), "updated_at" = now()
  FROM "_admin_create_mail_wording" AS w
 WHERE r."template_code" = w."template_code"
   AND r."title" IS NOT DISTINCT FROM r."default_title" AND r."body" = r."default_body"
   AND r."variables" = r."default_variables";

-- 되돌리기 원본: 2건 모두. updated_at 은 올리지 않는다 — 수정 화면의 낙관적 잠금(읽은 updatedAt)이 그 값이라, 운영자가 고친
-- 템플릿을 열어 둔 채 배포되면 지금 값은 그대로인데 저장이 409 가 된다. 지금 값을 바꾼 행은 위 UPDATE 가 이미 올렸다.
UPDATE "notification_templates" AS r
   SET "default_body" = replace(r."default_body", w."body_from", w."body_to")
  FROM "_admin_create_mail_wording" AS w
 WHERE r."template_code" = w."template_code";

-- 검증은 되돌리기 원본만 본다 — 지금 값은 운영자가 고쳤을 수 있다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r
    JOIN "_admin_create_mail_wording" AS w ON w."template_code" = r."template_code"
   WHERE position(w."body_to" IN r."default_body") > 0;
  IF n <> 2 THEN
    RAISE EXCEPTION '관리자 계정 생성 메일 2건의 기본 문구에 사용 기한이 들어가지 않았다: %', n;
  END IF;
END $$;

DROP TABLE "_admin_create_mail_wording";
