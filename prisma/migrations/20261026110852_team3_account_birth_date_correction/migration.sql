-- 직원 생년월일 정정 (WHALEERP-602, 재영 TAX-09 · 2026-10-21). 직원은 가입 뒤 생년월일을 고치지 않는다(ACC-13). 가입 때 잘못
-- 넣으면 신고 정보의 주민등록번호 앞자리 검사에 걸려 저장할 수 없으므로, 관리자가 확인해 정정하는 길만 둔다
-- (PUT /staff-members/:id/birth-date). 정정은 계정 이력(account_change_histories)에 남긴다.

-- AlterEnum — 정정 항목과 정정 경로를 끝에 더한다. 값 순서(더한 순서)가 화면 순서다(GET /enums).
-- ADD VALUE 는 같은 트랜잭션에서 새 값을 쓸 수 없지만, 이 파일은 값을 더하고 설명만 바꾼다.
ALTER TYPE "account_change_field" ADD VALUE 'BIRTH_DATE';
ALTER TYPE "account_change_channel" ADD VALUE 'ADMIN_CORRECTION';

COMMENT ON TYPE "account_change_field" IS '휴대전화번호 · 이메일 · 주소 · 비밀번호 · 생년월일';
COMMENT ON TYPE "account_change_channel" IS '본인 · 핀 재설정 · 관리자 초기화 · 관리자 정정';

COMMENT ON COLUMN "accounts"."birth_date" IS '생년월일 — 본인인증 값, 직원은 수정 불가 · 관리자 정정만 된다 (WHALEERP-602)';
COMMENT ON COLUMN "account_change_histories"."field" IS '변경 항목 — 휴대전화번호·이메일·주소·비밀번호·생년월일';
COMMENT ON COLUMN "account_change_histories"."channel" IS '변경 경로 — 본인·핀 재설정·관리자 초기화·관리자 정정';
COMMENT ON COLUMN "account_change_histories"."requested_by" IS '요청 관리자 — 관리자 초기화 · 관리자 정정일 때';
