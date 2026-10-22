// 어댑터(@prisma/adapter-pg)는 Date 를 타임존 없는 UTC 글자로 주고받으므로 DB 세션은 UTC 여야 한다.
// PrismaService 는 시작 옵션 `-c TimeZone=UTC` 를 주지만, DATABASE_URL 의 `?options=` 가 그 값을 덮어쓰거나
// (pg 는 URL 값을 config 위에 병합한다) 서버 · 풀러가 시작 옵션을 무시하면(PGlite 소켓 서버 등) 세션은
// 서버 기본 시간대가 된다 — 시각이 9시간 어긋나고 SQL 의 한국 날짜 계산이 하루 밀린다(2026-10-22).
// 그래서 부팅 때 실제 세션 값을 확인해, UTC 가 아니면 앱을 띄우지 않는다.

/** 부팅 때 실제 세션 시간대를 확인한다. 메시지에 연결 URL · 비밀번호는 싣지 않는다. */
export function assertUtcSessionTimeZone(timeZone: string | undefined): void {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return;
  const shown = timeZone === undefined ? '(읽지 못함)' : `'${timeZone}'`;
  throw new Error(
    `DB 세션 TimeZone 이 ${shown} 다 — UTC 가 아니면 시각이 어긋나므로 부팅을 멈춘다. ` +
      '(1) DATABASE_URL 에 ?options= 가 있으면 코드의 -c TimeZone=UTC 를 통째로 덮어쓰므로 빼거나 그 안에 -c TimeZone=UTC 를 넣는다. ' +
      '(2) 서버 · 풀러가 시작 옵션을 무시하면 DB 기본 timezone 을 UTC 로 둔다.',
  );
}
