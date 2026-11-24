-- 급여명세서 금액 줄의 근무시간(분)과 한 줄 계산식 — 임금명세서 기재사항(근로기준법 시행령 제27조의2 5호: 출근일수 · 시간에 따라
-- 달라지는 항목의 계산방법, 연장 · 야간 · 휴일근로의 시간 수)을 관리자 상세 · 직원 앱 · PDF 가 같은 글자로 보인다
-- (WHALEERP-755, 2026-11-20 김지영 결정).
-- - work_minutes: 기본급(파트타이머) · 주휴수당 · 연장수당은 계산에 쓴 분, 야간 · 휴일근무수당은 관리자가 넣은 분. 정직원 기본급 ·
--   주휴와 계산하지 않은 줄은 NULL.
-- - calculation_text: api 가 계산 때 만든 식(「8.0시간 × 10,320원 × 1.5배」). 기간 중 시급이 바뀌면 금액만으로 식을 다시 만들 수
--   없고 발송한 문서의 식은 바뀌지 않아야 해서 저장한다. 관리자가 계산값과 다른 금액으로 고치면 「직접 입력」.
--
-- 기존 행은 채우지 않는다(NULL — 화면 · PDF 는 지금처럼 식 없이 보인다). 지금까지 발송한 명세서는 개발 서버 시험분뿐이다.
--
-- 배포: Prisma 는 select 없는 쓰기에 칸 이름을 모두 나열한다. 적용하기 전에 새 코드가 돌면 payslip_items 를 쓰는 요청(명세서
-- 작성 · 임시저장 · 다시 계산)이 500(42703)이 된다. db:deploy 직후 새 컨테이너로 바꾼다.
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. front 논리 ERD 카탈로그에는 없는 물리 추가 칸이다.
ALTER TABLE "payslip_items" ADD COLUMN "work_minutes" INTEGER;
ALTER TABLE "payslip_items" ADD COLUMN "calculation_text" VARCHAR(200);

COMMENT ON COLUMN "payslip_items"."work_minutes" IS '근무시간 — 계산 · 입력에 쓴 시간(분) — 기본급(파트타이머) · 주휴 · 연장은 계산 때, 야간 · 휴일근무수당은 관리자가 넣는다 (WHALEERP-755, 2026-11-24) (물리에서 추가)';
COMMENT ON COLUMN "payslip_items"."calculation_text" IS '계산식 — 한 줄 계산식 — 관리자가 계산값과 다른 금액으로 고치면 「직접 입력」. 계산하지 않으면 NULL (WHALEERP-755, 2026-11-24) (물리에서 추가)';
