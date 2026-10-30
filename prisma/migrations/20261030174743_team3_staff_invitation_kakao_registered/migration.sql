-- 가입 초대 알림톡(TALK_STAFF_INVITATION)을 카카오(비즈뿌리오)에 등록한 템플릿과 똑같이 맞춘다(WHALEERP-636, 2026-10-30 김민식 — 등록 완료).
--
-- 알림톡은 등록한 본문과 글자 · 줄바꿈까지 같아야 나간다. 지금 본문은 20261030093710_team3_notification_template_wording(노영주)의
-- 문구(「[WHALE ERP] 직원 근무 앱 가입 초대」 제목 줄 · 「아래 버튼을 눌러…」 · 「- 초대 코드:」 · 「※」 두 줄)라 등록본과 다르고,
-- 카카오 템플릿 코드도 옛 이름 WHALE_INVITE_01 이라 등록한 코드(TALK_STAFF_INVITATION)와 다르다.
-- - 본문 · 되돌리기 원본(default_body)을 등록본으로 바꾼다. 빈 줄 없이 다섯 줄이다.
-- - 카카오 템플릿 코드를 등록한 코드로 바꾼다.
-- - 변수 목록(근무지 · 초대코드 · 링크=버튼 링크)은 되돌리기 원본(default_variables, 20261020144028)으로 맞춘다 — 발송 코드는 이 셋만
--   넘기므로 운영자가 필수 변수를 더했거나 버튼 링크 표시를 옮겼으면 등록본 본문으로도 발송이 막힌다.
-- - 제목(null) · 이름 · 사용 여부는 그대로다. 버튼(「가입하기」, 링크 변수 「링크」)은 코드가
--   싣는다(src/alimtalk/alimtalk-buttons.ts). 카카오 등록본의 버튼 변수 이름(가입링크)은 요청에 최종 URL 이 들어가 우리 변수 이름과 상관없다.
--
-- 운영자가 고친 문구도 덮어쓴다(20261030120100 과 같다) — 등록본과 다른 문구는 카카오가 거절해 대체 문자로만 간다.
-- 변경 이력은 남기지 않는다. 문자열은 달러 인용($t$ … $t$)이라 줄바꿈이 등록본 그대로다. 저장소에 .gitattributes 가 없어
-- Windows 체크아웃(autocrlf)은 이 파일을 CRLF 로 바꾸므로 \r 을 지워 넣고, 등록본 전체가 같은지 · \r 이 없는지 검증한다.
-- 채널이 알림톡이 아닌 행(운영자가 바꿈)은 카카오 코드를 넣으면 CHECK 에 걸리므로 바꾸지 않고 검증에서 멈춘다.

CREATE TEMP TABLE "_staff_invitation_registered" AS
SELECT replace($t$#{근무지}에서 근로계약서를 보내려고 합니다.
아래 링크를 누르면 WHALE ERP 직원 근무 앱에서 바로 가입할 수 있습니다.
앱에서 직접 가입할 때는 휴대전화번호와 초대 코드를 입력해 주세요.
초대 코드: #{초대코드}
초대 코드와 링크는 30일 동안 쓸 수 있습니다.$t$, E'\r', '') AS "body";

UPDATE "notification_templates" AS r
   SET "body" = t."body", "default_body" = t."body", "variables" = COALESCE(r."default_variables", r."variables"),
       "kakao_template_code" = 'TALK_STAFF_INVITATION',
       "updated_at" = now()
  FROM "_staff_invitation_registered" AS t
 WHERE r."template_code" = 'TALK_STAFF_INVITATION' AND r."channel" = 'ALIMTALK';

-- 본문은 등록본 전체(\r 없이, 다섯 줄), 본문이 쓰는 변수(근무지 · 초대코드)와 버튼 링크 변수(링크 하나에만 표시)가 변수 목록에 있어야
-- 발송 · 저장 검사를 지난다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates" AS r, "_staff_invitation_registered" AS t
   WHERE r."template_code" = 'TALK_STAFF_INVITATION'
     AND r."channel" = 'ALIMTALK'
     AND r."kakao_template_code" = 'TALK_STAFF_INVITATION'
     AND r."body" = t."body" AND r."default_body" = t."body"
     AND position(E'\r' IN r."body") = 0
     AND array_length(string_to_array(r."body", E'\n'), 1) = 5
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "근무지")')
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "초대코드")')
     AND jsonb_path_exists(r."variables", '$[*] ? (@.name == "링크" && @.isButtonLink == true)')
     AND NOT jsonb_path_exists(r."variables", '$[*] ? (@.name != "링크" && @.isButtonLink == true)');
  IF n <> 1 THEN
    RAISE EXCEPTION '가입 초대 알림톡 템플릿이 카카오 등록본과 같아지지 않았다: %', n;
  END IF;
END $$;

DROP TABLE "_staff_invitation_registered";
