// 어댑터(@prisma/adapter-pg)는 Date 를 타임존 없는 UTC 글자로 주고받으므로 DB 세션은 UTC 여야 한다.
// pg 8 은 `Object.assign({}, config, parse(connectionString))` 로 URL 값을 config 위에 덮어쓴다
// (lib/connection-parameters.js). 그래서 DATABASE_URL 에 `?options=...` 가 있으면 config 의
// `options: '-c TimeZone=UTC'` 가 사라지고 세션은 서버 기본 시간대(Asia/Seoul 등)가 된다 — 시각이 9시간
// 어긋나고 SQL 의 한국 날짜 계산이 하루 밀린다(2026-10-22). URL 의 options 에 UTC 를 덧붙인 값을 쓴다.
// 풀러가 시작 옵션을 버리는 경우는 부팅 때 assertUtcSessionTimeZone 이 잡는다.

import type { PrismaPg } from '@prisma/adapter-pg';
import { parse } from 'pg-connection-string';

// pg.PoolConfig — @types/pg 를 직접 들이지 않고 어댑터 생성자 인자에서 꺼낸다(문자열 · Pool 인스턴스는 뺀다).
type PoolConfig = Exclude<
  ConstructorParameters<typeof PrismaPg>[0],
  string | { query: unknown }
>;

export const UTC_TIME_ZONE_OPTION = '-c TimeZone=UTC';

const TIME_ZONE_SETTING = /^timezone=/i;

/**
 * libpq 의 `options`(`-c name=value` · `-cname=value` · `--name=value`, 역슬래시로 띄운 공백은 값의 일부)에서
 * TimeZone 설정을 빼고 맨 뒤에 `-c TimeZone=UTC` 를 둔다. 다른 설정은 순서 그대로 지킨다.
 * 한계: 역슬래시 자체를 쓴 값(`\\` 뒤 공백)은 공백을 띄운 것으로 읽어 나누지 않는다 — TimeZone 은 어차피 맨 뒤 UTC 가 이긴다.
 */
export function withUtcTimeZone(options: string | null | undefined): string {
  const tokens = (options ?? '').split(/(?<!\\)\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-c' && TIME_ZONE_SETTING.test(tokens[i + 1] ?? '')) {
      i++;
      continue;
    }
    if (/^(-c|--)timezone=/i.test(token)) continue;
    kept.push(token);
  }
  return [...kept, UTC_TIME_ZONE_OPTION].join(' ');
}

/**
 * PrismaPg(= pg.Pool) 에 넘길 연결 설정. URL 에 options 가 없으면 URL 은 건드리지 않고 config 의 options 로 UTC 를 준다.
 * 있으면 pg 와 같은 파서(pg-connection-string)로 읽은 값에 options 만 바꿔 connectionString 없이 넘긴다 — pg 가 안에서
 * 하는 병합(config 위에 parse 결과)과 같은 결과라, 소켓 · 빈 호스트 URL 도 pg 와 다르게 읽히지 않는다.
 */
export function pgConnectionConfig(
  databaseUrl: string | undefined,
): PoolConfig {
  if (!databaseUrl) {
    return { connectionString: databaseUrl, options: UTC_TIME_ZONE_OPTION };
  }
  const parsed = parse(databaseUrl);
  if (typeof parsed.options !== 'string') {
    return { connectionString: databaseUrl, options: UTC_TIME_ZONE_OPTION };
  }
  // parse 결과(port 가 문자열 · host 가 null 일 수 있음)는 pg 가 안에서 그대로 받는 모양이다.
  return {
    ...(parsed as PoolConfig),
    options: withUtcTimeZone(parsed.options),
  };
}

/** 부팅 때 실제 세션 시간대를 확인한다 — 풀러가 시작 옵션을 무시해도 UTC 가 아니면 뜨지 않는다. */
export function assertUtcSessionTimeZone(timeZone: string | undefined): void {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return;
  throw new Error(
    `DB 세션 TimeZone 이 UTC 가 아니라 '${timeZone}' 다 — 어댑터가 Date 를 UTC 글자로 주고받아 시각이 어긋나므로 부팅을 멈춘다. ` +
      'DATABASE_URL 의 options 나 커넥션 풀러(시작 옵션 무시)를 확인한다',
  );
}
