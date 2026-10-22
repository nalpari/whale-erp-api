-- 초대 코드 입력 시도의 is_succeeded 설명 바로잡기 (api #93 리뷰 후속). 처음에는 「성공 여부」였지만 api #93 부터 재발송이
-- 쌓는 잠금 해제 행도 true 라, 뜻은 「이 행부터 실패를 다시 센다」다(살아 있는 초대에 맞은 코드 · 재발송 잠금 해제). 칸과 값은 그대로다.
--
-- 줄은 물리 생성기 출력(docs/raw/2026-10-06-3팀-schema.sql)에서 옮겼다. 원본은 front 논리 ERD 카탈로그(docs/erd/README.md)다.
COMMENT ON COLUMN "invitation_code_attempts"."is_succeeded" IS '다시 세기 기준 — 기본 false. 살아 있는 초대에 맞은 코드 · 재발송 잠금 해제 행이 true(끝난 초대에 맞은 코드는 false) — 이 행부터 실패를 다시 센다 (api #93)';
