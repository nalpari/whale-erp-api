-- 인증 주체 테이블. 직원(staff)과 고객(customers)은 로그인 엔드포인트도, 접근
-- 범위도 다르므로 한 테이블에 role 컬럼으로 섞지 않는다.
--
-- refresh_token_hash 는 발급한 리프레시 토큰의 sha256 이다. 원문을 저장하지
-- 않는 이유는 DB 가 새면 그대로 로그인 수단이 되기 때문이고, 저장 자체를
-- 생략하지 않는 이유는 그래야 로그아웃과 강제 만료가 가능하기 때문이다.

CREATE TABLE "staff" (
    "id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "refresh_token_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customers" (
    "id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "refresh_token_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_email_key" ON "staff"("email");
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CHECK 제약: Prisma 스키마 언어로 표현할 수 없어 여기에만 존재한다.
-- db pull 은 이 제약을 schema.prisma 로 되살리지 못하므로 삭제하지 말 것.
-- email 을 lower() 로 강제하는 이유: 대소문자만 다른 계정이 유니크 인덱스를
-- 통과해 두 개 생기면 로그인이 어느 쪽에 붙을지가 입력 표기에 좌우된다.
ALTER TABLE "staff" ADD CONSTRAINT "staff_email_lower"
  CHECK ("email" = lower("email") AND length(trim(both from "email")) > 0);
ALTER TABLE "staff" ADD CONSTRAINT "staff_name_not_blank"
  CHECK (length(trim(both from "name")) > 0);
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_lower"
  CHECK ("email" = lower("email") AND length(trim(both from "email")) > 0);
ALTER TABLE "customers" ADD CONSTRAINT "customers_name_not_blank"
  CHECK (length(trim(both from "name")) > 0);
