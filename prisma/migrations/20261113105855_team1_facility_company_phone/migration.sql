-- 시설물·장비 구매처 · A/S센터 전화번호에 전국 대표번호 8자리 허용 (2026-11-13, 사용자 결정).
--
-- A/S센터와 구매처는 1588-1234 같은 대표번호를 많이 쓰는데, 20261111153316_team1_facilities 의
-- facilities_phone_format 은 네 칸 모두 숫자 9~12자리만 받아 저장할 수 없었다. 구매처(vendor_phone) ·
-- A/S센터(service_center_phone)만 15xx · 16xx · 18xx 로 시작하는 8자리를 더 받는다. 8자리를 아무 번호나 받으면
-- 끝자리를 빠뜨린 010-1234 같은 번호도 통과하므로 앞자리로 묶는다. 영업사원 · 관리 담당자는 사람 번호라 그대로다.
-- 저장값은 지금처럼 하이픈 없는 숫자다(15881234).
--
-- 적용된 마이그레이션은 고치지 않으므로 같은 이름으로 지우고 다시 만든다. 넓히기만 하므로 기존 행은 모두 통과한다.
-- api 검사(SaveFacilityDto · 일괄 등록 checkBulkRow)는 src/facilities/facility-format.ts 의 COMPANY_PHONE_PATTERN 과 같다.

ALTER TABLE "facilities" DROP CONSTRAINT "facilities_phone_format";
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_phone_format" CHECK (
  "vendor_phone" ~ '^([0-9]{9,12}|(15|16|18)[0-9]{6})$' AND "sales_representative_phone" ~ '^[0-9]{9,12}$'
  AND "manager_phone" ~ '^[0-9]{9,12}$' AND "service_center_phone" ~ '^([0-9]{9,12}|(15|16|18)[0-9]{6})$');

COMMENT ON COLUMN "facilities"."vendor_phone" IS '구매처 전화번호 — 숫자 9~12자리 또는 15xx·16xx·18xx 대표번호 8자리';
COMMENT ON COLUMN "facilities"."service_center_phone" IS 'A/S센터 전화번호 — 숫자 9~12자리 또는 15xx·16xx·18xx 대표번호 8자리';

-- 넓힌 제약이 실제로 대표번호를 받고 사람 번호 칸은 여전히 막는지 확인한다(행을 남기지 않는다).
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = '"facilities"'::regclass AND conname = 'facilities_phone_format';
  IF def IS NULL THEN
    RAISE EXCEPTION 'facilities_phone_format 이 없습니다';
  END IF;
  IF '15881234' !~ '^([0-9]{9,12}|(15|16|18)[0-9]{6})$'
     OR '12345678' ~ '^([0-9]{9,12}|(15|16|18)[0-9]{6})$' THEN
    RAISE EXCEPTION '대표번호 패턴이 기대와 다릅니다';
  END IF;
  IF position('(15|16|18)' IN def) = 0 THEN
    RAISE EXCEPTION 'facilities_phone_format 에 대표번호가 들어가지 않았습니다: %', def;
  END IF;
END $$;
