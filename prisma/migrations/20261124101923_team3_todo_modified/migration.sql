-- TO-DO 상세의 「최종수정」 — 관리자가 [수정](제목 · 내용 · 수행 예정 일시 · 긴급)으로 마지막으로 고친 때와 그 관리자를 남긴다
-- (WHALEERP-698, 2026-11-20 김지영 결정). updated_at(@updatedAt)은 상태 변경 · 직원 앱 완료 · 삭제에도 바뀌어 쓸 수 없다.
-- 상태 변경은 「상태 변경이력」에 사람 · 시각이 이미 남아 여기에 넣지 않는다. 근로계약(WHALEERP-699)과 같은 방식이다.
-- 묶음 TO-DO 는 [수정]이 묶음 전체 행에 같은 값을 쓴다.
--
-- 기존 행은 채우지 않는다(NULL — 상세에 「최종수정」 줄이 없다). 관리자 [수정]을 따로 남긴 기록이 없고, 긴급만 바꾼
-- 수정은 이력에 남지만 제목 · 내용 · 일시만 바꾼 수정은 어디에도 없어 근사할 수 없다.
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다.
ALTER TABLE "todos" ADD COLUMN "modified_at" TIMESTAMPTZ(6);
ALTER TABLE "todos" ADD COLUMN "modified_by" INTEGER;

ALTER TABLE "todos" ADD CONSTRAINT "todos_modified_by_fkey" FOREIGN KEY ("modified_by") REFERENCES "admin_accounts" ("admin_account_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON COLUMN "todos"."modified_at" IS '최종수정 일시 — 관리자 [수정] 때만, 상태 변경은 바꾸지 않는다 (WHALEERP-698, 2026-11-24) (물리에서 추가)';
COMMENT ON COLUMN "todos"."modified_by" IS '최종수정 관리자 — 관리자 [수정] 때만, 상태 변경은 바꾸지 않는다 (WHALEERP-698, 2026-11-24) (물리에서 추가)';
