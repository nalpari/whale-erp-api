-- 앞선 세 마이그레이션이 만들거나 값을 더한 enum 에 타입 설명(한글)을 붙인다 (2026-10-12).
--   20261008000900_team3_invitation_channel_push   invitation_channel 에 PUSH
--   20261007000300_team3_contract_terms            pay_month 새로 만듦
--   20261008001000_team3_contract_status_draft     contract_status 맨 앞에 DRAFT
-- 세 파일은 enum 설명 규칙(20261012144829) 전에 만들어져 공용 DB 에 적용됐으므로 고치지 않고 여기서 채운다.
-- 20261012144829 는 invitation_channel · contract_status 에 값을 더하기 전의 설명을 붙이므로, 이 파일이 전체 목록으로 다시 쓴다.
-- 물리 결정은 docs/erd-physical/_model.py 의 ENUMS.
COMMENT ON TYPE "invitation_channel" IS 'SMS · 알림톡 · 앱 푸시';
COMMENT ON TYPE "pay_month" IS '당월 · 익월';
COMMENT ON TYPE "contract_status" IS '임시저장 · 발송 대기 · 서명 대기 · 체결 완료 · 거부 · 만료 · 종료';
