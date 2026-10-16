-- 근로계약 상태 「수정 요청」(WHALEERP-125 「본인 대조」 · 126, 2026-10-16 김민식 결정).
-- 직원이 가입 값(이름 · 휴대전화번호 · 생년월일 · 성별 · 외국인 여부)과 계약서 값이 달라 날인할 수 없을 때 계약서를 확인하고
-- 수정을 요청하면 서명 대기 → 수정 요청. 관리자가 고치면 발송 대기로 돌아가고, 발송이 다시 보내 서명 대기가 된다.
-- 수정 요청 중에는 서명 기한이 흐르지 않는다(만료 배치는 서명 대기만 본다).

-- AlterEnum — 서명 대기 다음 자리. 이름 순서가 화면 순서다(GET /enums).
ALTER TYPE "contract_status" ADD VALUE 'CORRECTION_REQUESTED' AFTER 'PENDING_SIGNATURE';
COMMENT ON TYPE "contract_status" IS '임시저장 · 발송 대기 · 서명 대기 · 수정 요청 · 체결 완료 · 거부 · 만료 · 종료';
