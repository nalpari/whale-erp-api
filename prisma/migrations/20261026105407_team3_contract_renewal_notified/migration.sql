-- 갱신 예정 알림 · 메일을 계약마다 한 번만 보내려고 보낸 때를 남긴다(WHALEERP-152, 2026-10-26 김민식).
-- 메일 발송 이력(mail_send_logs)에는 계약을 가리키는 칸이 없어 중복을 막는 데 쓸 수 없다.
ALTER TABLE "contracts" ADD COLUMN "renewal_notified_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN "contracts"."renewal_notified_at" IS '갱신 예정 알림 일시 — 갱신 예정 알림 · 메일을 보낸 때 — 계약마다 한 번 (WHALEERP-152, 2026-10-26 김민식) (물리에서 추가)';
