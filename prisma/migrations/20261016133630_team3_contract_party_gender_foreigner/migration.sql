-- 근로계약서 직원 정보에 성별 · 외국인 여부 (WHALEERP-125 「본인 대조」 · 128 · 132, 2026-10-16 김민식 결정).
-- 가입 때 직원이 직접 넣은 이름 · 휴대전화번호 · 생년월일 · 성별 · 외국인 여부를 계약서 값과 대조해 모두 같아야 날인한다.
-- 성별은 초안 저장부터 필수(화면 · api 가 본다), 임시저장은 비워 둘 수 있어 NULL 허용. 외국인 여부는 체크라 늘 값이 있다 —
-- 이미 있는 계약은 성별 없음 · 내국인(false)으로 시작한다. 지금 고칠 수 있는 것은 임시저장뿐이고, 발송 대기 · 서명 대기는
-- 「날인 전 근로자 정보 수정」(WHALEERP-125 · 126, 다음 작업)이 생기면 관리자가 채운다 — 그 전에는 본인 대조가 붙지 않는다.

-- CreateEnum
CREATE TYPE "gender" AS ENUM ('MALE', 'FEMALE');
COMMENT ON TYPE "gender" IS '남 · 여';

-- AlterTable
ALTER TABLE "contract_parties"
    ADD COLUMN "entered_gender" "gender",
    ADD COLUMN "is_foreigner" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "contract_parties"."entered_gender" IS '관리자 입력 성별 — 남 · 여 — 가입 값과 본인 대조 (WHALEERP-125, 2026-10-16) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."is_foreigner" IS '관리자 입력 외국인 여부 — 체크하지 않으면 내국인 — 가입 값과 본인 대조 (WHALEERP-125, 2026-10-16) (물리에서 추가)';
