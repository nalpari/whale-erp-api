-- 근로계약 상세의 「최종수정」 — 관리자가 마지막으로 고치거나 보낸 때와 그 관리자를 남긴다 (WHALEERP-699, 2026-11-13 김민식).
-- updated_at(@updatedAt)은 직원 서명 · 거절 · 소속 확인 응답과 만료 · 종료 · 갱신 알림 배치에도 바뀌어 쓸 수 없다.
-- 이 두 칸은 관리자 웹의 등록 · 저장 · 근로자 정보 수정 · 발송 · 재발송 · 발송 대기 종료에서만 채운다.
--
-- 기존 행은 남은 기록으로 근사한다 — 관리자 쓰기를 따로 남긴 적이 없어 정확한 값은 없다.
-- - modified_at: 등록 일시 · 마지막 발송 일시(sent_at) · 관리자(ADMIN) 상태 이력의 마지막 시각 가운데 가장 늦은 것.
--   상태를 바꾸지 않은 저장(임시저장 이어 쓰기 · 상태 그대로의 근로자 정보 수정)은 이 기록에 없어 그보다 이를 수 있다.
-- - modified_by: 그 시각이 등록 일시와 1초 안이면(등록이 sent_at · 첫 이력을 몇 ms 차이로 함께 쓴다) 등록 관리자,
--   아니면 어느 관리자인지 몰라 비운다(NULL — 상세는 관리자 칸을 비워 보인다).
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. front 논리 ERD 카탈로그에는 없는 물리 추가 칸이다.
ALTER TABLE "contracts" ADD COLUMN "modified_at" TIMESTAMPTZ(6);
ALTER TABLE "contracts" ADD COLUMN "modified_by" INTEGER;

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_modified_by_fkey" FOREIGN KEY ("modified_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

UPDATE "contracts" c
SET "modified_at" = t."at",
    "modified_by" = CASE
      WHEN c."created_at" IS NOT NULL AND t."at" <= c."created_at" + INTERVAL '1 second' THEN c."created_by"
      ELSE NULL
    END
FROM (
  SELECT c2."contract_id",
         GREATEST(
           c2."created_at",
           c2."sent_at",
           (SELECT MAX(h."changed_at")
              FROM "contract_status_histories" h
             WHERE h."contract_id" = c2."contract_id" AND h."actor" = 'ADMIN')
         ) AS "at"
    FROM "contracts" c2
) t
WHERE t."contract_id" = c."contract_id";

COMMENT ON COLUMN "contracts"."modified_at" IS '최종수정 일시 — 관리자가 고치거나 보낸 때만 (직원 서명 · 배치는 바꾸지 않는다) (WHALEERP-699, 2026-11-13) (물리에서 추가)';
COMMENT ON COLUMN "contracts"."modified_by" IS '최종수정 관리자 — 관리자가 고치거나 보낸 때만 (직원 서명 · 배치는 바꾸지 않는다) (WHALEERP-699, 2026-11-13) (물리에서 추가)';
