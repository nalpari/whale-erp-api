-- 급여명세서 검토 사유 「확인 필요 기록 포함」(ATTENDANCE_NEEDS_REVIEW)의 상세 문장을 사유를 앞에 두는 문장으로 바꾼다
-- (WHALEERP-757, 2026-11-20 김지영 결정). 상세는 만들 때 저장되므로 이미 저장된 행도 같은 문장으로 고친다 — 관리자 웹이
-- 옛 문장을 정규식으로 바꿔 보이던 코드를 빼면 기존 명세서에 옛 문장이 다시 보이기 때문이다. 직원에게 보이는 발행 문서가
-- 아니라 관리자 상세의 「검토 사유」 글자라 고쳐도 된다.
--
-- 저장된 옛 문장은 두 세대다.
-- - 2026-11-10(d35f5c9c) 뒤: 「확인 필요로 표시된 출퇴근 기록이 N건 있습니다(근무지 반경 밖 퇴근, 위치 조작 감지 등).」 ·
--   「이번 급여 기간과 첫 주에 포함된 지난달 날짜(9월 28일~9월 30일)에 확인 필요로 표시된 출퇴근 기록이 N건 있습니다.」
-- - 그 전: 「급여 기간에 확인 필요 출퇴근 기록이 N건 있습니다.」(10-29 전에는 끝 마침표 없음) · 「급여 기간과 첫 주 앞 달 날(09-28 ~ 09-30)에 확인 필요
--   출퇴근 기록이 N건 있습니다.」 — 날짜 표기는 그때 모양(MM-DD) 그대로 둔다(되살릴 연 · 형식 정보가 없고, 뜻은 같다).
-- 바뀌는 행만 고친다. 사람이 고친 문장 등 어느 모양에도 맞지 않는 행은 그대로 둔다.
-- 검증이 실패하면 앞의 UPDATE 도 되돌리도록 한 트랜잭션으로 묶는다(Prisma 는 마이그레이션을 감싸지 않는다).

BEGIN;

-- ① 11-10 뒤 기본 문장
UPDATE "payslip_review_reasons"
SET "detail" = regexp_replace(
  "detail",
  '^확인 필요로 표시된 출퇴근 기록이 ([0-9]+)건 있습니다\(근무지 반경 밖 퇴근, 위치 조작 감지 등\)\.$',
  '근무지 반경 밖 퇴근, 위치 조작 감지 등의 사유로 확인이 필요한 출퇴근 기록이 \1건 있습니다.'
)
WHERE "review_reason" = 'ATTENDANCE_NEEDS_REVIEW'
  AND "detail" ~ '^확인 필요로 표시된 출퇴근 기록이 [0-9]+건 있습니다\(근무지 반경 밖 퇴근, 위치 조작 감지 등\)\.$';

-- ② 11-10 뒤 앞 달 날짜 문장
UPDATE "payslip_review_reasons"
SET "detail" = replace("detail", '확인 필요로 표시된 출퇴근 기록이', '확인이 필요한 출퇴근 기록이')
WHERE "review_reason" = 'ATTENDANCE_NEEDS_REVIEW'
  AND "detail" LIKE '이번 급여 기간과 첫 주에 포함된 지난달 날짜(%)에 확인 필요로 표시된 출퇴근 기록이 %건 있습니다.';

-- ③ 11-10 전 기본 문장(끝 마침표가 없던 10-29 전 것도)
UPDATE "payslip_review_reasons"
SET "detail" = regexp_replace(
  "detail",
  '^급여 기간에 확인 필요 출퇴근 기록이 ([0-9]+)건 있습니다\.?$',
  '근무지 반경 밖 퇴근, 위치 조작 감지 등의 사유로 확인이 필요한 출퇴근 기록이 \1건 있습니다.'
)
WHERE "review_reason" = 'ATTENDANCE_NEEDS_REVIEW'
  AND "detail" ~ '^급여 기간에 확인 필요 출퇴근 기록이 [0-9]+건 있습니다\.?$';

-- ④ 11-10 전 앞 달 날짜 문장
UPDATE "payslip_review_reasons"
SET "detail" = regexp_replace(
  "detail",
  '^급여 기간과 첫 주 앞 달 날\((.+)\)에 확인 필요 출퇴근 기록이 ([0-9]+)건 있습니다\.$',
  '이번 급여 기간과 첫 주에 포함된 지난달 날짜(\1)에 확인이 필요한 출퇴근 기록이 \2건 있습니다.'
)
WHERE "review_reason" = 'ATTENDANCE_NEEDS_REVIEW'
  AND "detail" ~ '^급여 기간과 첫 주 앞 달 날\(.+\)에 확인 필요 출퇴근 기록이 [0-9]+건 있습니다\.$';

-- 검증: 위 네 모양(UPDATE 와 같은 조건)의 옛 문장이 남지 않았다 — 모양이 다른 행은 일부러 두므로 세지 않는다
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM "payslip_review_reasons"
   WHERE "review_reason" = 'ATTENDANCE_NEEDS_REVIEW'
     AND ("detail" ~ '^확인 필요로 표시된 출퇴근 기록이 [0-9]+건 있습니다\(근무지 반경 밖 퇴근, 위치 조작 감지 등\)\.$'
       OR "detail" LIKE '이번 급여 기간과 첫 주에 포함된 지난달 날짜(%)에 확인 필요로 표시된 출퇴근 기록이 %건 있습니다.'
       OR "detail" ~ '^급여 기간에 확인 필요 출퇴근 기록이 [0-9]+건 있습니다\.?$'
       OR "detail" ~ '^급여 기간과 첫 주 앞 달 날\(.+\)에 확인 필요 출퇴근 기록이 [0-9]+건 있습니다\.$');
  IF n <> 0 THEN
    RAISE EXCEPTION '확인 필요 기록 포함 사유에 옛 문장이 남았다: %건', n;
  END IF;
END $$;

COMMIT;
