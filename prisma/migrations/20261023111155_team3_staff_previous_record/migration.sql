-- 재입사 레코드를 이전 재직 레코드와 잇는다 (WHALEERP-615, 2026-10-22 김민식). 퇴직한 직원이 같은 점포에 다시 입사하면
-- 지금처럼 새 레코드를 만들고(api #65), 새 레코드에 같은 사람의 직전 재직 레코드를 남긴다 — 재직 기간마다 입사일 · 퇴직일 ·
-- 계약 · 명세서가 따로 남고, 직원 상세가 이 칸으로 재직 이력을 잇는다. 기존 레코드는 채우지 않는다(이 칸이 없을 때 만든
-- 재입사 레코드는 이력이 비어 보인다).
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. front 논리 ERD 카탈로그에는 없는 물리 추가 칸이다.
ALTER TABLE "staff_members" ADD COLUMN "previous_staff_member_id" INTEGER;

ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_previous_staff_member_id_fkey" FOREIGN KEY ("previous_staff_member_id") REFERENCES "staff_members" ("staff_member_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 직원 상세 재직 이력이 이 레코드를 이은 이후 레코드를 찾는다 — 없으면 PK 를 끝까지 훑지 않게. 직원 행 삭제의 외래키 검사도 쓴다.
CREATE INDEX "staff_members_previous_staff_member_id_idx" ON "staff_members" ("previous_staff_member_id");

COMMENT ON COLUMN "staff_members"."previous_staff_member_id" IS '이전 재직 레코드 — 재입사 레코드만 — 같은 점포에서 퇴직한 같은 사람의 직전 레코드 (물리에서 추가)';
