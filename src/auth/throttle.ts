import { ThrottlerOptions } from '@nestjs/throttler';
import { hashToken } from './password';

/**
 * 로그인·갱신·로그아웃·비밀번호 재설정 경로의 요청 제한.
 *
 * 두 축이 모두 필요하다. IP 축만 두면 봇넷이 한 계정을 나눠 두드리는 것을
 * 못 막고, 계정 축만 두면 한 IP 가 계정을 갈아 가며 scrypt 를 갈아 넣는 것을
 * 못 막는다. 검증 자체가 비싼(~30ms) 경로라 후자는 CPU 고갈로 이어진다.
 *
 * IP 는 `req.ip` 다. Express 의 trust proxy 를 켜지 않았으므로 프록시 뒤에서는
 * 프록시의 주소가 되어 모든 사용자가 한 IP 버킷을 쓴다. 그래서 갱신·로그아웃은
 * IP 축에서 빼고(`@SkipThrottle({ ip: true })`) 토큰 축으로만 센다 — 15분마다
 * 모든 앱이 부르는 경로가 한 버킷을 나누면 사용자가 늘수록 서로를 막는다.
 * 로그인·재설정의 IP 축은 프록시 구성이 정해지면(인프라) 다시 본다.
 *
 * ponytail: 저장소가 프로세스 메모리라 인스턴스마다 따로 센다. 여러 대로
 * 늘리면 한도가 대수만큼 늘어나므로, 그때 공용 저장소(Redis)로 바꾼다.
 */
export function ipTracker(req: Record<string, unknown>): string {
  const socket = req.socket as { remoteAddress?: string } | undefined;
  // 주소를 못 얻어도 던지지 않는다. 한 버킷에 묶이는 편이 무제한보다 낫다.
  return (req.ip as string) ?? socket?.remoteAddress ?? 'unknown';
}

/** 계정 축. 이메일 → 토큰 → IP 순으로 셀 기준을 고른다. */
export function accountTracker(req: Record<string, unknown>): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  // 로그인은 소문자로 정규화해 조회한다. 카운트 키가 다르면 대소문자만
  // 바꿔 가며 제한을 우회할 수 있다.
  if (typeof email === 'string' && email.trim())
    return `account:${email.trim().toLowerCase()}`;
  // 갱신은 본문의 갱신 토큰, 로그아웃은 Bearer 토큰으로 센다. 원문 대신 해시를
  // 키로 쓴다 — 저장소의 키가 그대로 자격이 되지 않게.
  const token = bodyRefreshToken(req) ?? bearerToken(req);
  if (token) return `token:${hashToken(token)}`;
  // 셀 기준이 없는 요청을 상수 키로 묶으면 한 명이 전체를 막는다.
  return `ip:${ipTracker(req)}`;
}

function bodyRefreshToken(req: Record<string, unknown>): string | undefined {
  const token = (req.body as { refreshToken?: unknown } | undefined)
    ?.refreshToken;
  return typeof token === 'string' && token ? token : undefined;
}

function bearerToken(req: Record<string, unknown>): string | undefined {
  const header = (req.headers as { authorization?: unknown } | undefined)
    ?.authorization;
  if (typeof header !== 'string') return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : undefined;
}

export const AUTH_THROTTLERS: ThrottlerOptions[] = [
  { name: 'ip', ttl: 60_000, limit: 30, getTracker: ipTracker },
  { name: 'account', ttl: 600_000, limit: 10, getTracker: accountTracker },
];
