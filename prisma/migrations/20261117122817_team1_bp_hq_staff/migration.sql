-- BP 본사 좌표 · 본사 직원 관리 스위치 (WHALEERP-724, 2026-11-17 사용자 지정).
--
-- 본사(BP 마스터가 마이페이지에서 인증까지 마친 BP 사업자정보)도 근무지가 된다(front docs/raw/2026-11-17-근무지-본사근무-정책.md).
-- 1인 매장 사장님이 본사 개념으로 헷갈리지 않게 본사 기능은 「본사 직원 관리」를 켠 BP 에만 보인다 — 기본 꺼짐.
--   - latitude · longitude · is_location_applied 는 stores 와 같은 모양이다(본사근무 직원의 출퇴근 위치 확인 기준).
--     위치 적용 기본값만 stores(true)와 달리 false 다 — 기존 BP 에는 좌표가 없다.
--   - is_hq_staff_enabled 는 사업자정보 인증 · 좌표가 있어야 켤 수 있다. api(BpProfileService)가 먼저 막고, 이 CHECK 가
--     그 규칙을 DB 에서도 지킨다 — 켠 채로 인증을 지우거나 좌표를 지우는 저장은 실패한다.
--   - 위도 · 경도는 함께 있거나 함께 없다(bp_codes_coordinates_pair).
--   - 본사근무 직원이 있으면 끌 수 없다는 규칙은 본사근무 직원(WHALEERP-725)이 생길 때 api 가 더한다.

ALTER TABLE "bp_codes"
    ADD COLUMN "latitude" NUMERIC(8,6),
    ADD COLUMN "longitude" NUMERIC(9,6),
    ADD COLUMN "is_location_applied" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "is_hq_staff_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_latitude_range" CHECK ("latitude" BETWEEN -90 AND 90);
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_longitude_range" CHECK ("longitude" BETWEEN -180 AND 180);
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_coordinates_pair" CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_location_applied_requires_coordinates"
    CHECK (NOT "is_location_applied" OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL));
ALTER TABLE "bp_codes" ADD CONSTRAINT "bp_codes_hq_staff_enabled_requires_verified_location"
    CHECK (NOT "is_hq_staff_enabled" OR ("biz_verified_at" IS NOT NULL AND "latitude" IS NOT NULL AND "longitude" IS NOT NULL));

COMMENT ON COLUMN "bp_codes"."latitude" IS '본사 위도 — 소수점 6자리. 본사근무 직원 출퇴근 위치 확인 기준';
COMMENT ON COLUMN "bp_codes"."longitude" IS '본사 경도 — 소수점 6자리';
COMMENT ON COLUMN "bp_codes"."is_location_applied" IS '본사 위치 적용 여부 — 기본 false(미사용). true 면 본사근무 직원 출퇴근을 위도·경도로 판정, 좌표가 있어야 켠다';
COMMENT ON COLUMN "bp_codes"."is_hq_staff_enabled" IS '본사 직원 관리 — 기본 false. true 면 [본사근무] · 헤더 본사 범위 · 본사 근무지가 보인다. 사업자정보 인증 · 좌표가 있어야 켠다';
