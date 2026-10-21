-- 지금 비밀번호 확인 없이 낸 이메일 변경 핀을 닫는다 (WHALEERP-607, 운영 정책 ACC-13 · api #91 리뷰).
--
-- 이 PR 부터 이메일 변경 핀은 지금 비밀번호가 맞을 때만 나간다. 그런데 확인 단계(`POST /me/profile/email-change`)는
-- 비밀번호를 보지 않고 가장 새 열린 핀만 보므로, 배포 전에 토큰만으로 받은 핀이 배포 뒤에도 15분 동안 쓰인다. 그 핀을
-- 쓴 것으로 닫는다 — 직원은 새 핀을 받으면 된다(핀은 15분짜리라 잃는 것이 없다).
--
-- 지우지 않고 used_at 을 채운다 — 1분 간격 · 하루 10회는 발급 시각으로 세므로 행이 남아야 한다. 이 파일이 적용되는
-- 시각보다 앞서 낸 핀만 닫는다. 같은 시각 판단을 한 블록 안에서 해, 적용하는 사이 새 api 가 낸 핀은 건드리지 않는다.
-- 배포 순서상 새 api 가 뜬 뒤에 적용해야 옛 api 가 그 사이 낸 핀까지 닫힌다 — 먼저 적용해도 해는 없지만 그 틈이 남는다.

DO $$
DECLARE
  cutoff timestamptz := clock_timestamp();
  n integer;
BEGIN
  UPDATE "email_change_pins" SET "used_at" = cutoff
   WHERE "used_at" IS NULL AND "issued_at" <= cutoff;

  SELECT count(*) INTO n FROM "email_change_pins" WHERE "used_at" IS NULL AND "issued_at" <= cutoff;
  IF n <> 0 THEN
    RAISE EXCEPTION '닫히지 않은 이메일 변경 핀 %건', n;
  END IF;
END $$;
