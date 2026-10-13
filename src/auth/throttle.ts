import { createHmac, randomBytes } from 'node:crypto';
import { ThrottlerOptions } from '@nestjs/throttler';
import { hashToken } from './password';

/**
 * 로그인·갱신·로그아웃·비밀번호 재설정·이메일 찾기 경로의 요청 제한.
 *
 * 두 축이 모두 필요하다. IP 축만 두면 봇넷이 한 계정을 나눠 두드리는 것을
 * 못 막고, 계정 축만 두면 한 IP 가 계정을 갈아 가며 scrypt 를 갈아 넣는 것을
 * 못 막는다. 검증 자체가 비싼(~30ms) 경로라 후자는 CPU 고갈로 이어진다.
 * 이메일 찾기에는 scrypt 가 없다. 거기서 IP 축은 번호를 바꿔 가며 이름 · 생년월일을
 * 맞혀 보는 것을 늦춘다(번호 축은 번호마다 새 버킷이라 그것을 못 막는다).
 *
 * IP 는 `req.ip` 다. Express 의 trust proxy 를 켜지 않았으므로 프록시 뒤에서는
 * 프록시의 주소가 되어 모든 사용자가 한 IP 버킷을 쓴다.
 * - 갱신은 15분마다 모든 앱이 부르는 경로라, 30/분 버킷을 나누면 사용자가 늘수록
 *   서로를 막는다. 그래서 IP 한도를 `REFRESH_IP_LIMIT` 로 넉넉히 올린다. 빼 버리면
 *   토큰 축은 토큰마다 새 버킷이라 무작위 토큰을 무한히 보낼 수 있다.
 * - 로그아웃은 유효한 액세스 토큰이 있어야 닿는 경로라(전역 JWT 가드가 먼저 돈다)
 *   IP 축이 막을 것이 없어 뺀다(`@SkipThrottle({ ip: true })`).
 * - 로그인·재설정·이메일 찾기의 IP 축은 프록시 구성이 정해지면(인프라) 다시 본다.
 *
 * ponytail: 저장소가 프로세스 메모리라 인스턴스마다 따로 센다. 여러 대로
 * 늘리면 한도가 대수만큼 늘어나므로, 그때 공용 저장소(Redis)로 바꾼다.
 */
export function ipTracker(req: Record<string, unknown>): string {
  const socket = req.socket as { remoteAddress?: string } | undefined;
  // 주소를 못 얻어도 던지지 않는다. 한 버킷에 묶이는 편이 무제한보다 낫다.
  return (req.ip as string) ?? socket?.remoteAddress ?? 'unknown';
}

/**
 * 계정 축. 경로가 아니라 요청에 실린 것으로 기준을 고른다 — 본문 이메일 → 본문 휴대전화번호
 * (이메일 찾기, HMAC) → 본문 갱신 토큰 → Bearer 토큰 → IP 순이다.
 */
export function accountTracker(req: Record<string, unknown>): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  // 로그인은 소문자로 정규화해 조회한다. 카운트 키가 다르면 대소문자만
  // 바꿔 가며 제한을 우회할 수 있다.
  if (typeof email === 'string' && email.trim())
    return `account:${email.trim().toLowerCase()}`;
  // 이메일 찾기는 이메일을 모르는 사람이 부르는 경로라 넣은 번호로 센다. 검증 전이라 숫자만 남긴다 —
  // 하이픈 · 공백만 바꿔 가며 제한을 우회하지 못하게.
  const phone = (req.body as { phone?: unknown } | undefined)?.phone;
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (digits) return `phone:${phoneBucketKey(digits)}`;
  // 갱신은 본문의 갱신 토큰, 로그아웃은 Bearer 토큰으로 센다. 원문 대신 해시를
  // 키로 쓴다 — 저장소의 키가 그대로 자격이 되지 않게.
  const token = bodyRefreshToken(req) ?? bearerToken(req);
  if (token) return `token:${hashToken(token)}`;
  // 셀 기준이 없는 요청을 상수 키로 묶으면 한 명이 전체를 막는다.
  return `ip:${ipTracker(req)}`;
}

/**
 * 번호 축의 키. 번호는 경우의 수가 적어 sha256 은 다 넣어 보면 되돌아가므로 HMAC 을 쓴다. 키는 프로세스가 뜰
 * 때 만든다 — 지금 저장소가 프로세스 메모리라 그것으로 충분하다. 공용 저장소(Redis)로 바꾸면 인스턴스마다
 * 키가 달라 같은 번호가 다른 버킷이 되므로, 그때 공유하는 비밀 키로 바꾼다.
 */
const PHONE_BUCKET_KEY = randomBytes(32);
function phoneBucketKey(digits: string): string {
  return createHmac('sha256', PHONE_BUCKET_KEY).update(digits).digest('hex');
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
  // 가드와 같이 스킴의 대소문자는 가리지 않는다(RFC 7235 §2.1).
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/** 갱신 경로의 IP 한도. 공유 IP 에서도 정상 갱신(사용자당 15분에 한 번)을 막지 않을 만큼. */
export const REFRESH_IP_LIMIT = { limit: 600, ttl: 60_000 };

export const AUTH_THROTTLERS: ThrottlerOptions[] = [
  { name: 'ip', ttl: 60_000, limit: 30, getTracker: ipTracker },
  { name: 'account', ttl: 600_000, limit: 10, getTracker: accountTracker },
];
