-- 가맹 마스터(FM000001)의 출 · 퇴근 현황(MN000025) 권한에 등록 · 수정을 연다 (WHALEERP-223 · 운영 정책 ATT-37, 2026-10-26 재영).
--
-- 1팀 초기 데이터는 조회만이라 가맹 마스터 · 가맹 관리자 모두 보정 · 이상 없음 · 대신 등록을 할 수 없었다. 1차에는 가맹도
-- 보고 보정한다. 가맹 관리자 권한 그룹은 가맹 마스터를 상한으로 각자 켠다. 1팀 요청서(R)와 다른 점은 1팀 전달 목록 26번이다.
UPDATE "role_group_menus" AS rgm
SET "is_creatable" = true, "is_updatable" = true, "updated_at" = CURRENT_TIMESTAMP
FROM "role_groups" AS rg, "menus" AS m
WHERE rgm."role_group_id" = rg."role_group_id"
  AND rgm."menu_id" = m."menu_id"
  AND rg."role_code" = 'FM000001'
  AND m."menu_code" = 'MN000025';
