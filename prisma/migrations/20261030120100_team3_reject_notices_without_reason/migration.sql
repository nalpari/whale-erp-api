-- 근로계약 거부 · 소속 추가 거절 알림에서 사유를 뺀다(WHALEERP-635, 2026-10-30 김민식 — 직원 앱이 두 거절 모두 사유를 받지 않는다).
--
-- 원문은 같은 날의 문구 정리 20261030093710_team3_notification_template_wording(노영주) 뒤의 기본 문구다. 제목은 그대로 둔다.
-- - 운영 알림 NTF_CONTRACT_REJECTED: 「- 거부 사유: #{거부사유}」 줄을 날인 · 만료 알림과 같은 「- 근무지: #{근무지}」로 바꾸고,
--   변수 목록의 거부사유를 근무지(필수)로 바꾼다(2026-10-30 김민식).
-- - 메일 EMAIL_CONTRACT_REJECTED: 「- 거부 사유: #{거부사유}」 줄과 변수 거부사유를 뺀다.
-- - 운영 알림 NTF_AFFILIATION_REJECTED · 메일 EMAIL_AFFILIATION_REJECTED: 문구 정리가 넣은 「- 거절 사유: #{거절사유}」 줄과
--   변수 거절사유를 뺀다(2026-10-30 김민식). 발송 코드는 거절사유를 넘긴 적이 없어 지금까지 빈 줄로 나갔다.
--
-- 운영자가 고친 문구도 덮어쓴다(20261015164811 과 같다). 고친 문구를 두면 그 안의 사유 변수가 빈 값으로 남거나, 거부 운영 알림에
-- 새로 넘기는 근무지가 변수 목록에 없어 렌더러가 「없는 변수」로 막는다. 2026-10-30 개발 DB 의 네 템플릿은(20261030093710 적용 뒤)
-- 제목 · 본문 · 변수가 모두 기본값 그대로였고 변경 이력도 없었다. 되돌리기 원본(default_*)도 같은 값으로 바꾼다. 변경 이력은 남기지 않는다.
-- 발송 코드(ContractNoticeService)는 같은 PR 에서 거부사유를 넘기지 않고 거부 운영 알림에 근무지를 넘긴다 — 이 파일만 적용되고
-- 옛 코드가 돌면 거부 알림이 「없는 변수」로 막히므로 머지 직후 바로 deploy 한다.
-- 문자열은 달러 인용($t$ … $t$)이라 줄바꿈이 문구 그대로다.

UPDATE "notification_templates"
   SET "body" = v."body", "default_body" = v."body",
       "variables" = v."variables", "default_variables" = v."variables",
       "updated_at" = now()
  FROM (VALUES
    ('NTF_CONTRACT_REJECTED', $t$#{직원이름} 님이 근로계약서 서명을 거부했습니다.

- 근무지: #{근무지}

필요하면 계약 조건을 수정해
근로계약서를 다시 보내 주세요.$t$,
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb),
    ('EMAIL_CONTRACT_REJECTED', $t$#{직원이름} 님이 근로계약서 서명을 거부했습니다.

- 근무지: #{근무지}

필요하면 계약 조건을 수정해
근로계약서를 다시 보내 주세요.$t$,
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb),
    ('NTF_AFFILIATION_REJECTED', $t$#{직원이름} 님이 소속 추가 요청을 거절했습니다.

- 근무지: #{근무지}

필요하면 소속 추가를 다시 요청해 주세요.$t$,
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb),
    ('EMAIL_AFFILIATION_REJECTED', $t$#{직원이름} 님이 소속 추가 요청을 거절했습니다.

- 근무지: #{근무지}

필요하면 소속 추가를 다시 요청해 주세요.$t$,
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb)
  ) AS v("code", "body", "variables")
 WHERE "template_code" = v."code";

-- 검증은 이번에 바꾼 칸(body · variables · default_*)만 본다 — 제목 · 사용 여부는 템플릿 관리 화면에서 고칠 수 있다.
-- 제목에 사유 변수가 남아 있으면 변수 목록에서 빠진 자리라 알림이 매번 막히므로 그것만은 멈춘다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('NTF_CONTRACT_REJECTED', 'EMAIL_CONTRACT_REJECTED',
                             'NTF_AFFILIATION_REJECTED', 'EMAIL_AFFILIATION_REJECTED')
     AND position('사유' IN "body") = 0
     AND position('- 근무지: #{근무지}' IN "body") > 0
     AND "body" = "default_body" AND "variables" = "default_variables"
     AND NOT jsonb_path_exists("variables", '$[*] ? (@.name == "거부사유" || @.name == "거절사유")')
     AND jsonb_path_exists("variables", '$[*] ? (@.name == "근무지" && @.isRequired == true)')
     AND position('#{거부사유}' IN coalesce("title", '')) = 0
     AND position('#{거절사유}' IN coalesce("title", '')) = 0;
  IF n <> 4 THEN
    RAISE EXCEPTION '근로계약 거부 · 소속 추가 거절 알림 템플릿 4건에서 사유가 빠지지 않았다: %', n;
  END IF;
END $$;
