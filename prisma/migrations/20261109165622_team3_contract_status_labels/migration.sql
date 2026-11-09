-- 근로계약 상태 표시 이름을 바꾸고 화면의 「날인」을 「서명」으로 통일한다(WHALEERP-659, 2026-11-09).
--
-- 1) enum 타입 설명 — GET /enums 한글의 유일한 출처(CLAUDE.md 「Migration rules」 6). 값과 순서는 그대로, 전체 목록을 다시 쓴다.
--    - contract_status: 작성 중 · 서명 요청 전 · 직원 서명 대기 · 직원 수정 요청 · 서명 완료 · 서명 거절 · 계약 기간 만료 · 계약 종료.
--      EXPIRED 의 이름은 「계약 기간 만료」지만 서명 기한이 지나 만료된 것이라는 뜻은 그대로다(만료 알림 문구도 그대로 둔다).
--    - contract_document_kind: SIGNED_COPY 「날인 완료본」 → 「서명 완료본」.
-- 2) 알림 템플릿 기본 문구 — 근로계약 서명 완료 · 서명 거절 알림 4건의 제목 · 본문과 소속 추가 확인 요청 메일 1건의 본문.
--    - NTF_CONTRACT_SIGNED · EMAIL_CONTRACT_SIGNED: 제목 「근로계약 체결 완료」 → 「근로계약 서명 완료」,
--      본문 「근로계약 체결이 완료되었습니다.」 → 「근로계약 서명이 완료되었습니다.」
--    - NTF_CONTRACT_REJECTED · EMAIL_CONTRACT_REJECTED: 제목 「서명 거부」 → 「서명 거절」, 본문 「거부했습니다」 → 「거절했습니다」.
--    - EMAIL_STAFF_AFFILIATION_REQUEST(직원에게 가는 메일): 본문 「근로계약서를 받아 날인할 수 있고」 → 「…서명할 수 있고」. 제목은 그대로.
--    20261030093710_team3_notification_template_wording 과 같은 방식이다 — 지금 값(title · body · variables)이 셋 다 되돌리기
--    원본(default_*)과 같을 때만 지금 값을 바꾸고(운영자가 고친 문구는 둔다), 그 다음에 되돌리기 원본을 바꾼다. 변경 이력은 남기지 않는다.
-- 3) 변수 표시 이름 — PUSH_CONTRACT_SENT · TALK_STAFF_CONTRACT_SENT 의 변수 날인기한의 label 「날인 기한」 → 「서명 기한」.
--    변수 이름 · 본문 · 카카오 등록 문구는 그대로다(발송 코드가 날인기한으로 넘긴다). 지금 값은 2) 와 같은 조건일 때만 바꾼다.
-- 4) 템플릿 이름 — default 칸이 없어 처음 넣은 이름(20261007000200)과 같을 때만 바꾼다.
--    근로계약 날인 → 근로계약 서명 완료, 근로계약 거부 → 근로계약 서명 거절, 근로계약 만료 → 근로계약 서명 기한 만료(운영 알림 · 메일 각 1건).
-- 5) 칸 설명 — contracts.status · contract_documents.kind 의 COMMENT 도 새 이름으로(물리 생성기 출력 docs/raw/2026-10-06-3팀-schema.sql 과 같게).
-- enum 값 · 테이블 구조는 바꾸지 않는다.

COMMENT ON TYPE "contract_status" IS '작성 중 · 서명 요청 전 · 직원 서명 대기 · 직원 수정 요청 · 서명 완료 · 서명 거절 · 계약 기간 만료 · 계약 종료';
COMMENT ON TYPE "contract_document_kind" IS '발송 원본 · 서명 완료본 · 종이 계약 근로계약서 · 임금계약서 · 서명 이미지';
COMMENT ON COLUMN "contracts"."status" IS '계약 상태 — 작성 중·서명 요청 전·직원 서명 대기·직원 수정 요청·서명 완료·서명 거절·계약 기간 만료·계약 종료';
COMMENT ON COLUMN "contract_documents"."kind" IS '파일 구분 — 발송 원본·서명 완료본·종이 계약 근로계약서·임금계약서·서명 이미지';

-- 2) 제목 · 본문 ---------------------------------------------------------------------------------------------------------------

CREATE TEMP TABLE "_contract_template_wording" (
  "template_code" text PRIMARY KEY,
  "title_from" text NOT NULL,
  "title_to" text NOT NULL,
  "body_from" text NOT NULL,
  "body_to" text NOT NULL
);

INSERT INTO "_contract_template_wording" VALUES
  ('NTF_CONTRACT_SIGNED', '근로계약 체결 완료', '근로계약 서명 완료',
   '근로계약 체결이 완료되었습니다.', '근로계약 서명이 완료되었습니다.'),
  ('EMAIL_CONTRACT_SIGNED', '[WHALE ERP] 근로계약 체결 완료', '[WHALE ERP] 근로계약 서명 완료',
   '근로계약 체결이 완료되었습니다.', '근로계약 서명이 완료되었습니다.'),
  ('NTF_CONTRACT_REJECTED', '근로계약서 서명 거부', '근로계약서 서명 거절',
   '근로계약서 서명을 거부했습니다.', '근로계약서 서명을 거절했습니다.'),
  ('EMAIL_CONTRACT_REJECTED', '[WHALE ERP] 근로계약서 서명 거부', '[WHALE ERP] 근로계약서 서명 거절',
   '근로계약서 서명을 거부했습니다.', '근로계약서 서명을 거절했습니다.'),
  ('EMAIL_STAFF_AFFILIATION_REQUEST', '[WHALE ERP] #{근무지}에서 소속 추가를 요청했습니다', '[WHALE ERP] #{근무지}에서 소속 추가를 요청했습니다',
   '근로계약서를 받아 날인할 수 있고', '근로계약서를 받아 서명할 수 있고');

-- 되돌리기 원본이 이 파일이 아는 옛 문구 그대로인지 먼저 본다 — 아니면 replace 가 아무것도 바꾸지 않고 지나간다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r
    JOIN "_contract_template_wording" AS w ON w."template_code" = r."template_code"
   WHERE r."default_title" = w."title_from" AND position(w."body_from" IN r."default_body") > 0;
  IF n <> 5 THEN
    RAISE EXCEPTION '문구를 바꿀 알림 템플릿 5건의 기본 문구가 옛 문구가 아니다: %', n;
  END IF;
END $$;

-- 지금 값: 셋 다 되돌리기 원본 그대로일 때만. default_* 를 바꾸기 전에 비교한다.
UPDATE "notification_templates" AS r
   SET "title" = w."title_to", "body" = replace(r."body", w."body_from", w."body_to"), "updated_at" = now()
  FROM "_contract_template_wording" AS w
 WHERE r."template_code" = w."template_code"
   AND r."title" IS NOT DISTINCT FROM r."default_title" AND r."body" = r."default_body"
   AND r."variables" = r."default_variables";

-- 되돌리기 원본: 5건 모두.
UPDATE "notification_templates" AS r
   SET "default_title" = w."title_to", "default_body" = replace(r."default_body", w."body_from", w."body_to"),
       "updated_at" = now()
  FROM "_contract_template_wording" AS w
 WHERE r."template_code" = w."template_code";

-- 검증은 되돌리기 원본만 본다 — 지금 값은 운영자가 고쳤을 수 있다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r
    JOIN "_contract_template_wording" AS w ON w."template_code" = r."template_code"
   WHERE r."default_title" = w."title_to" AND position(w."body_to" IN r."default_body") > 0
     AND position(w."body_from" IN r."default_body") = 0;
  IF n <> 5 THEN
    RAISE EXCEPTION '알림 템플릿 5건의 기본 문구가 새 문구로 바뀌지 않았다: %', n;
  END IF;
END $$;

DROP TABLE "_contract_template_wording";

-- 3) 변수 표시 이름 -------------------------------------------------------------------------------------------------------------

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('PUSH_CONTRACT_SENT', 'TALK_STAFF_CONTRACT_SENT')
     AND jsonb_path_exists("default_variables", '$[*] ? (@.name == "날인기한" && @.label == "날인 기한")');
  IF n <> 2 THEN
    RAISE EXCEPTION '변수 표시 이름을 바꿀 근로계약서 발송 템플릿 2건이 옛 표시 이름이 아니다: %', n;
  END IF;
END $$;

-- 지금 값: 제목 · 본문 · 변수 목록이 셋 다 되돌리기 원본 그대로일 때만.
UPDATE "notification_templates"
   SET "variables" = (
         SELECT jsonb_agg(CASE WHEN e->>'name' = '날인기한' THEN jsonb_set(e, '{label}', '"서명 기한"') ELSE e END ORDER BY i)
           FROM jsonb_array_elements("variables") WITH ORDINALITY AS t(e, i)),
       "updated_at" = now()
 WHERE "template_code" IN ('PUSH_CONTRACT_SENT', 'TALK_STAFF_CONTRACT_SENT')
   AND "title" IS NOT DISTINCT FROM "default_title" AND "body" = "default_body"
   AND "variables" = "default_variables";

UPDATE "notification_templates"
   SET "default_variables" = (
         SELECT jsonb_agg(CASE WHEN e->>'name' = '날인기한' THEN jsonb_set(e, '{label}', '"서명 기한"') ELSE e END ORDER BY i)
           FROM jsonb_array_elements("default_variables") WITH ORDINALITY AS t(e, i)),
       "updated_at" = now()
 WHERE "template_code" IN ('PUSH_CONTRACT_SENT', 'TALK_STAFF_CONTRACT_SENT');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('PUSH_CONTRACT_SENT', 'TALK_STAFF_CONTRACT_SENT')
     AND jsonb_path_exists("default_variables", '$[*] ? (@.name == "날인기한" && @.label == "서명 기한")')
     AND NOT jsonb_path_exists("default_variables", '$[*] ? (@.label == "날인 기한")');
  IF n <> 2 THEN
    RAISE EXCEPTION '근로계약서 발송 템플릿 2건의 변수 표시 이름이 서명 기한으로 바뀌지 않았다: %', n;
  END IF;
END $$;

-- 4) 템플릿 이름 ---------------------------------------------------------------------------------------------------------------

UPDATE "notification_templates" AS r
   SET "template_name" = v."name_to", "updated_at" = now()
  FROM (VALUES
    ('NTF_CONTRACT_SIGNED', '근로계약 날인', '근로계약 서명 완료'),
    ('EMAIL_CONTRACT_SIGNED', '근로계약 날인', '근로계약 서명 완료'),
    ('NTF_CONTRACT_REJECTED', '근로계약 거부', '근로계약 서명 거절'),
    ('EMAIL_CONTRACT_REJECTED', '근로계약 거부', '근로계약 서명 거절'),
    ('NTF_CONTRACT_EXPIRED', '근로계약 만료', '근로계약 서명 기한 만료'),
    ('EMAIL_CONTRACT_EXPIRED', '근로계약 만료', '근로계약 서명 기한 만료')
  ) AS v("code", "name_from", "name_to")
 WHERE r."template_code" = v."code" AND r."template_name" = v."name_from";

-- 운영자가 이름을 고쳤으면 그 이름은 두므로 바뀐 수는 6 이하다. 여섯 코드가 모두 있고, 옛 이름이 남은 것이 없는지 본다.
DO $$
DECLARE total integer; stale integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE "template_name" IN ('근로계약 날인', '근로계약 거부', '근로계약 만료'))
    INTO total, stale
    FROM "notification_templates"
   WHERE "template_code" IN ('NTF_CONTRACT_SIGNED', 'EMAIL_CONTRACT_SIGNED', 'NTF_CONTRACT_REJECTED',
                             'EMAIL_CONTRACT_REJECTED', 'NTF_CONTRACT_EXPIRED', 'EMAIL_CONTRACT_EXPIRED');
  IF total <> 6 OR stale <> 0 THEN
    RAISE EXCEPTION '근로계약 알림 템플릿 이름 6건이 바뀌지 않았다: 템플릿 %, 옛 이름 %', total, stale;
  END IF;
END $$;
