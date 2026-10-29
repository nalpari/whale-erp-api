-- 약관 v1.0 본문의 「MY PAGE」를 「마이페이지」로 바꾼다(사용자 결정 2026-10-29 — 화면 메뉴 이름이 「마이페이지」다).
--
-- 바꾸는 곳은 20261019124121_team1_terms_demo_content 가 고친 두 본문이다.
--   TERMS_SERVICE v1.0   제12조 「BP 마스터는 언제든지 MY PAGE 의 회원 탈퇴로…」 → 「마이페이지의」
--   PRIVACY_COLLECT v1.0 선택 입력 항목 「…MY PAGE 에서 언제든지 지울 수 있습니다」 → 「마이페이지에서」
-- 조사는 띄어 쓰지 않고 붙인다(「마이페이지의」 · 「마이페이지에서」). 본문의 「MY PAGE」는 이 두 곳뿐이고, 혹시 다른 꼴로 남은 것이 있어도 「마이페이지」로 바꾼다.
-- 20261006000100_team1_initial_data 의 요약 본문(제12조 「MY PAGE 회원탈퇴」)은 20261019124121 이 이미 덮어써 DB 에 남아 있지 않다.
-- 알림 템플릿 등 다른 테이블의 마이그레이션 데이터에는 「MY PAGE」가 없다(2026-10-29 마이그레이션 SQL 전체 확인).
--
-- 20261019124121 과 같이 새 버전 행을 쌓지 않고 v1.0 행을 고친다 — 출시 전 초안이라 버전 번호와 시행일을 그대로 두고
-- 동의 기록도 그대로 유효하게 한다. 메뉴 이름만 바꾸는 표기 수정이라 다시 동의받을 내용이 아니다. 출시 뒤 개정부터는 새 버전 행을 더한다.
-- 각 유형이 정확히 1건 바뀌었는지 확인하고, 아니면 마이그레이션 전체를 되돌린다.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE "terms_versions"
  SET "content" = replace(replace(replace("content",
        'MY PAGE 의', '마이페이지의'),
        'MY PAGE 에서', '마이페이지에서'),
        'MY PAGE', '마이페이지'),
      "updated_at" = now()
  WHERE "terms_type_code" = 'TERMS_SERVICE' AND "version" = 'v1.0' AND NOT "is_deleted"
    AND "content" LIKE '%MY PAGE%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION '「MY PAGE」가 든 약관 TERMS_SERVICE v1.0 이 1건이어야 하는데 %건이다', n; END IF;

  UPDATE "terms_versions"
  SET "content" = replace(replace(replace("content",
        'MY PAGE 의', '마이페이지의'),
        'MY PAGE 에서', '마이페이지에서'),
        'MY PAGE', '마이페이지'),
      "updated_at" = now()
  WHERE "terms_type_code" = 'PRIVACY_COLLECT' AND "version" = 'v1.0' AND NOT "is_deleted"
    AND "content" LIKE '%MY PAGE%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION '「MY PAGE」가 든 약관 PRIVACY_COLLECT v1.0 이 1건이어야 하는데 %건이다', n; END IF;

END $$;
