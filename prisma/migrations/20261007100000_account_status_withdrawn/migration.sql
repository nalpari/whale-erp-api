-- 3팀 계정 상태에 「탈퇴」를 더한다 (WHALEERP-168, 2026-10-07 노영주 결정).
--
-- 직원 계정은 퇴직해도 막지 않고 탈퇴하지 않는 한 로그인된다(ACC-15). 그런데 accounts.status 에는
-- 탈퇴를 나타낼 값이 없어, 탈퇴한 계정을 로그인에서 걸러낼 길이 없었다. 값 이름은 1팀 공통코드
-- ACCOUNT_STATUS 의 탈퇴 값과 같은 WITHDRAWN 이다.
--
-- 휴면 계정은 두지 않기로 했다(ACC-18). 그래서 휴면 값은 더하지 않고, 마지막 사용 시점으로 로그인을
-- 막는 일도 없다.
--
-- 20261007000000_team3_initial 은 개발 DB 에 이미 적용돼 고칠 수 없다(_model.MIGRATION_APPLIED).
-- 값을 더하는 것만 하므로 기존 행과 코드에 영향이 없다 — 지금 있는 계정은 모두 JOINED 나 LINK_HOLD 다.
--
-- ALTER TYPE ... ADD VALUE 는 같은 트랜잭션 안에서 새 값을 쓸 수 없다. 이 파일은 값을 더하고
-- 주석만 바꾸며 새 값을 쓰지 않는다.

ALTER TYPE "account_status" ADD VALUE 'WITHDRAWN';

COMMENT ON COLUMN "accounts"."status" IS '계정 상태 — 가입 완료·연결 보류·탈퇴';
