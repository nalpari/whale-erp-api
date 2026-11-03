-- 소속 추가 확인 요청 알림톡(TALK_STAFF_AFFILIATION_REQUEST)을 카카오(비즈뿌리오)에 등록한 템플릿과 똑같이 맞춘다(WHALEERP-130 후속,
-- 2026-11-03 김민식 — 등록 완료).
--
-- 20261027154954_team3_affiliation_request_templates 는 카카오 템플릿 코드를 등록 전 임시 이름 WHALE_AFFILIATION_01 로 넣었다. 등록한
-- 코드는 TALK_STAFF_AFFILIATION_REQUEST(기본형, 강조 제목 없음, 버튼 없음)다.
-- - 카카오 템플릿 코드를 등록한 코드로 바꾼다.
-- - 본문 · 되돌리기 원본(default_body)을 등록본으로 맞춘다. 등록본은 20261027154954 의 본문과 글자 · 줄바꿈까지 같은 네 줄이다 —
--   운영자가 고쳤으면 등록본으로 되돌린다.
-- - 버튼 링크 변수 「링크」를 변수 목록 · 되돌리기 원본(variables · default_variables)에서 뺀다. 등록본에 버튼이 없는데 버튼을 실으면
--   알림톡이 거절돼 대체 문자로 간다(2026-11-03 08:22Z 발송이 그랬다, 김민식 확인). 같은 PR 에서 코드도 이 템플릿의 버튼
--   (src/alimtalk/alimtalk-buttons.ts)을 빼고 링크를 넘기지 않는다. 버튼을 다시 넣으려면 카카오 재등록과 함께 한다.
--   남는 변수는 되돌리기 원본(default_variables, 20261027154954)의 사업자 · 근무지 · 고용형태다 — 발송 코드는 이 셋만 넘기므로 운영자가
--   필수 변수를 더했으면 등록본 본문으로도 발송이 막힌다.
-- - 제목(null) · 이름 · 사용 여부는 그대로다. 메일 EMAIL_STAFF_AFFILIATION_REQUEST 의 링크 버튼은 그대로다(알림톡만).
--
-- 배포: 코드와 함께 나가야 한다. 이 파일만 적용되면 옛 코드가 버튼 링크 변수가 없다고(LINK_MISMATCH), 코드만 나가면 남은 「링크」의
-- 버튼 이름이 없다고(NO_BUTTON_NAME) 소속 추가 확인 요청을 막는다 — 머지 직후 deploy 와 api 배포를 함께 한다.
--
-- 운영자가 고친 문구도 덮어쓴다(20261030174743 과 같다) — 등록본과 다른 문구는 카카오가 거절해 대체 문자로만 간다.
-- 변경 이력은 남기지 않는다. 문자열은 달러 인용($t$ … $t$)이라 줄바꿈이 등록본 그대로다. 저장소에 .gitattributes 가 없어
-- Windows 체크아웃(autocrlf)은 이 파일을 CRLF 로 바꾸므로 \r 을 지워 넣고, 등록본 전체가 같은지 · \r 이 없는지 검증한다.
-- 채널이 알림톡이 아닌 행(운영자가 바꿈)은 카카오 코드를 넣으면 CHECK 에 걸리므로 바꾸지 않고 검증에서 멈춘다.

CREATE TEMP TABLE "_staff_affiliation_registered" AS
SELECT replace($t$#{사업자} #{근무지}에서 소속 추가를 요청했습니다.
고용 형태: #{고용형태}
WHALE ERP 직원 근무 앱에 로그인해 요청을 확인하고 수락하면 근로계약서를 받을 수 있습니다.
요청은 30일 동안 유효합니다.$t$, E'\r', '') AS "body";

-- 변수 목록 · 되돌리기 원본은 되돌리기 원본에서 「링크」를 뺀 것(순서 그대로)이다. 원본이 없으면 지금 목록에서 뺀다.
-- SET 은 갱신 전 값을 보므로 두 칸 모두 같은 값이 된다.
UPDATE "notification_templates" AS r
   SET "body" = t."body", "default_body" = t."body",
       "variables" = (
         SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality), '[]'::jsonb)
           FROM jsonb_array_elements(COALESCE(r."default_variables", r."variables")) WITH ORDINALITY AS e
          WHERE e.value->>'name' <> '링크'),
       "default_variables" = (
         SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality), '[]'::jsonb)
           FROM jsonb_array_elements(COALESCE(r."default_variables", r."variables")) WITH ORDINALITY AS e
          WHERE e.value->>'name' <> '링크'),
       "kakao_template_code" = 'TALK_STAFF_AFFILIATION_REQUEST',
       "updated_at" = now()
  FROM "_staff_affiliation_registered" AS t
 WHERE r."template_code" = 'TALK_STAFF_AFFILIATION_REQUEST' AND r."channel" = 'ALIMTALK';

-- 본문은 등록본 전체(\r 없이, 네 줄), 본문이 쓰는 변수(사업자 · 근무지 · 고용형태) 셋만 있고 버튼 링크 변수는 없어야 발송 · 저장 검사를
-- 지난다(버튼이 없는 템플릿에 버튼 링크 변수가 있으면 NO_BUTTON_NAME).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r, "_staff_affiliation_registered" AS t
   WHERE r."template_code" = 'TALK_STAFF_AFFILIATION_REQUEST'
     AND r."channel" = 'ALIMTALK'
     AND r."kakao_template_code" = 'TALK_STAFF_AFFILIATION_REQUEST'
     AND r."body" = t."body" AND r."default_body" = t."body"
     AND position(E'\r' IN r."body") = 0
     AND array_length(string_to_array(r."body", E'\n'), 1) = 4
     AND r."variables" = r."default_variables"
     AND jsonb_array_length(r."variables") = 3
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "사업자")')
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "근무지")')
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "고용형태")')
     AND NOT jsonb_path_exists(r."variables", '$[*] ? (@.isButtonLink == true)');
  IF n <> 1 THEN
    RAISE EXCEPTION '소속 추가 확인 요청 알림톡 템플릿이 카카오 등록본과 같아지지 않았다: %', n;
  END IF;
END $$;

DROP TABLE "_staff_affiliation_registered";
