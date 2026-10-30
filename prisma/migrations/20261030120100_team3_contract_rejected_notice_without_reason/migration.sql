-- 근로계약 거부 알림에서 거부 사유를 뺀다(WHALEERP-635, 2026-10-30 김민식 — 직원 앱이 거부 사유를 받지 않는다).
--
-- 운영 알림 NTF_CONTRACT_REJECTED: 본문 「사유 · #{거부사유}」를 날인 알림(NTF_CONTRACT_SIGNED)과 같은 「#{근무지}」로 바꾸고
-- 변수 목록의 거부사유를 근무지(필수)로 바꾼다 — 사유 줄만 빼면 본문이 비어 템플릿 저장 검사(「본문을 넣어 주세요.」)에 막힌다
-- (2026-10-30 김민식). 메일 EMAIL_CONTRACT_REJECTED: 본문의 「거부 사유: #{거부사유}」 줄과 변수 목록의 거부사유를 뺀다.
-- 제목은 그대로다. 원본은 20261007000200_team3_notification_templates.
--
-- 운영자가 고친 문구도 덮어쓴다(20261015164811 과 같다). 고친 문구를 두면 그 안의 #{거부사유}가 빈 값으로 남거나, 거부 운영
-- 알림에 새로 넘기는 근무지가 변수 목록에 없어 렌더러가 「없는 변수」로 막는다. 2026-10-30 개발 DB 의 두 템플릿은 제목 · 본문 ·
-- 변수가 기본값 그대로였고 변경 이력도 없었다. 되돌리기 원본(default_*)도 같은 값으로 바꾼다. 변경 이력은 남기지 않는다.
-- 발송 코드(ContractNoticeService)는 같은 PR 에서 거부사유를 넘기지 않고 운영 알림에 근무지를 넘긴다 — 이 파일만 적용되고
-- 옛 코드가 돌면 거부 알림이 「없는 변수」로 막히므로 머지 직후 바로 deploy 한다.

UPDATE "notification_templates"
   SET "body" = v."body", "default_body" = v."body",
       "variables" = v."variables", "default_variables" = v."variables",
       "updated_at" = now()
  FROM (VALUES
    ('NTF_CONTRACT_REJECTED', '#{근무지}',
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb),
    ('EMAIL_CONTRACT_REJECTED', '#{직원이름} 님이 #{근무지} 근로계약서를 거부했습니다.

조건을 고쳐 새 계약을 만들거나 그대로 재발송할 수 있습니다.',
     '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb)
  ) AS v("code", "body", "variables")
 WHERE "template_code" = v."code";

-- 검증은 이번에 바꾼 칸(body · variables · default_*)만 본다 — 제목 · 사용 여부는 템플릿 관리 화면에서 고칠 수 있다.
-- 제목에 #{거부사유} 가 남아 있으면 변수 목록에서 빠진 자리라 거부 알림이 매번 막히므로 그것만은 멈춘다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" IN ('NTF_CONTRACT_REJECTED', 'EMAIL_CONTRACT_REJECTED')
     AND position('거부사유' IN "body") = 0 AND position('거부 사유' IN "body") = 0
     AND position('#{근무지}' IN "body") > 0
     AND "body" = "default_body" AND "variables" = "default_variables"
     AND NOT jsonb_path_exists("variables", '$[*] ? (@.name == "거부사유")')
     AND jsonb_path_exists("variables", '$[*] ? (@.name == "근무지" && @.isRequired == true)')
     AND position('#{거부사유}' IN coalesce("title", '')) = 0;
  IF n <> 2 THEN
    RAISE EXCEPTION '근로계약 거부 알림 템플릿 2건에서 거부사유가 빠지지 않았다: %', n;
  END IF;
END $$;
