-- 회원 탈퇴 정책 변경(2026-11-04 사용자 지정): 탈퇴한 BP 의 하위 관리자(BP 관리자 · 가맹 마스터 · 가맹 관리자)는
-- 탈퇴가 아니라 미사용으로 둔다. 개인정보(이름 · 휴대폰 · 이메일)는 탈퇴 때 이미 지웠다 — 혹시 남은 값도 함께 지운다.
-- 이 마이그레이션은 이미 탈퇴한 BP 의 하위 관리자를 새 규칙에 맞춘다. BP 마스터(BM)는 그대로 탈퇴다.
-- 상태 이력(admin_change_histories)에 「탈퇴 → 미사용」 한 줄을 남긴다 — 처리자는 없다(시스템).

WITH targets AS (
  SELECT a."admin_account_id"
  FROM "admin_accounts" a
  JOIN "bp_codes" b ON b."bp_code_id" = a."bp_code_id"
  WHERE b."account_status_code" = 'WITHDRAWN'
    AND a."account_status_code" = 'WITHDRAWN'
    AND a."role_type_code" <> 'BM'
    AND NOT a."is_deleted"
),
history AS (
  INSERT INTO "admin_change_histories" ("admin_account_id", "field", "before_value", "after_value", "changed_by", "changed_at")
  SELECT "admin_account_id", '계정 상태', '탈퇴', '미사용', NULL, now() FROM targets
)
UPDATE "admin_accounts" a
SET "account_status_code" = 'INACTIVE',
    "name" = NULL,
    "phone" = NULL,
    "email" = NULL
FROM targets t
WHERE a."admin_account_id" = t."admin_account_id";
