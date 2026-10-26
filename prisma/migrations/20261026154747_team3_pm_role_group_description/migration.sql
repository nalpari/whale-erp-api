-- 플랫폼 마스터 권한(PM000001) 설명을 바꾼다 (2026-10-26, front 디자인 수정 — 권한 그룹 상세에 보이는 문구).
-- 이 행은 1팀 초기 데이터(20261006000100_team1_initial_data)가 넣은 것이고, 플랫폼 마스터 권한은 화면에서 고칠 수
-- 없어(고정 권한) 데이터로 바꾼다. 적용된 마이그레이션은 고치지 않으므로 새 마이그레이션으로 UPDATE 한다.
-- 사람이 고친 것이 아니라 updated_at · updated_by 는 건드리지 않는다(「최종수정」이 이 변경으로 바뀌지 않게).

UPDATE "role_groups"
   SET "description" = '시스템 최상위 권한, 모든 메뉴의 접근·관리 권한이 자동 부여됨'
 WHERE "role_code" = 'PM000001'
   AND NOT "is_deleted";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "role_groups"
                  WHERE "role_code" = 'PM000001'
                    AND "description" = '시스템 최상위 권한, 모든 메뉴의 접근·관리 권한이 자동 부여됨') THEN
    RAISE EXCEPTION 'PM000001 설명이 바뀌지 않았다';
  END IF;
END $$;
