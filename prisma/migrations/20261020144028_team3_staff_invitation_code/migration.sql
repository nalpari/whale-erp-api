-- 가입 초대에 초대 코드를 더한다 (JOIN-7, 2026-10-19 재영 — 진입 · 가입 화면 가이드 · 2026-10-20 김민식, WHALEERP-136 · 141).
--
-- 직원은 알림톡의 초대 링크(`/invite#token=…`)로 열거나, 앱을 직접 열어 휴대전화번호와 본문의 초대 코드(대문자 · 숫자 8자리,
-- 0 · O · 1 · I 제외)로 가입을 시작한다. 링크 토큰은 지금처럼 invitation_token 에 sha256 으로, 코드는 새 칸
-- invitation_code_hash 에 HMAC-SHA256(JWT_SECRET) 으로 둔다. 코드는 휴대전화번호와 함께 찾으므로 인덱스를 둔다.
-- 이미 나간 초대에는 코드가 없고 링크도 옛 모양(`/invite/{토큰}`)이라 쓸 수단이 없다 — 발송 중(SENT)이면 만료로 둔다.
-- 관리자가 다시 보내면 코드와 새 링크가 생긴다(api #74 리뷰). 운영 전이라 개발 DB 만 영향을 받는다.
--
-- 알림톡 TALK_STAFF_INVITATION 변수: 근무지 · 초대코드(본문) · 링크(초대 링크, 버튼). 되돌리기 원본(default_*)도 같은 값으로
-- 바꾼다. 제목 · 채널 · 카카오 템플릿 코드(WHALE_INVITE_01)는 그대로다 — 카카오 템플릿 문구도 이 본문에 맞춰 다시 검수받아야
-- 한다. 운영 전이라 마이그레이션으로 고친다. 변경 이력은 남기지 않는다.
-- 발송 코드(ContractDeliveryService)는 초대코드를 넘긴다 — 이 파일이 적용되기 전에는 「없는 변수」로 가입 초대가 막히고(보내기 전
-- 실패라 저장을 되돌림), 적용한 뒤에는 거꾸로 초대코드를 넘기지 않는 옛 코드가 필수 변수 누락으로 막힌다. 머지 직후 바로 deploy 한다.

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN "invitation_code_hash" TEXT;

COMMENT ON COLUMN "invitations"."invitation_code_hash" IS '초대 코드 해시 — 초대 코드(8자리)의 HMAC-SHA256(JWT_SECRET) — 가입 초대·재초대만, 휴대전화번호와 함께 찾는다 (JOIN-7, 2026-10-19) (물리에서 추가)';

-- CreateIndex
CREATE INDEX "invitations_invitation_code_hash_idx" ON "invitations"("invitation_code_hash");

UPDATE "invitations" SET "status" = 'EXPIRED'
 WHERE "invitation_type" IN ('SIGNUP', 'REINVITE') AND "status" = 'SENT' AND "invitation_code_hash" IS NULL;

UPDATE "notification_templates"
   SET "body" = v."body", "default_body" = v."body",
       "variables" = v."variables", "default_variables" = v."variables",
       "updated_at" = now()
  FROM (VALUES ('#{근무지}에서 근로계약서를 보내려고 합니다.
아래 링크를 누르면 WHALE ERP 직원 근무 앱에서 바로 가입할 수 있습니다.
앱에서 직접 가입할 때는 휴대전화번호와 초대 코드를 입력해 주세요.
초대 코드: #{초대코드}
초대 코드와 링크는 30일 동안 쓸 수 있습니다.', '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "초대코드", "label": "초대 코드(대문자 · 숫자 8자리)", "isRequired": true, "sampleValue": "K7Q2M9PX"}, {"name": "링크", "label": "초대 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…/invite#token=…", "isButtonLink": true}]'::jsonb)) AS v("body", "variables")
 WHERE "template_code" = 'TALK_STAFF_INVITATION';

-- 검증은 이번에 바꾼 칸만 본다 — 제목 · 채널은 템플릿 관리 화면에서 고칠 수 있다.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "notification_templates"
   WHERE "template_code" = 'TALK_STAFF_INVITATION'
     AND position('#{초대코드}' IN "body") > 0
     AND "body" = "default_body"
     AND "variables" = "default_variables" AND jsonb_array_length("variables") = 3
     AND "variables" -> 1 ->> 'name' = '초대코드';
  IF n <> 1 THEN
    RAISE EXCEPTION 'TALK_STAFF_INVITATION 이 초대 코드 본문으로 바뀌지 않았다: %', n;
  END IF;
END $$;
