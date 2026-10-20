import { createHmac, randomBytes } from 'node:crypto';
import { ThrottlerOptions } from '@nestjs/throttler';
import { isIPv4 } from 'node:net';
import { expandIpv6, isIpv4Mapped } from '../config/ipv6';
import { hashToken } from './password';

/**
 * 로그인·갱신·로그아웃·비밀번호 재설정·이메일 찾기, 관리자 웹 회원가입·중복 확인·아이디 찾기 경로의 요청 제한.
 *
 * 두 축이 모두 필요하다. IP 축만 두면 봇넷이 한 계정을 나눠 두드리는 것을
 * 못 막고, 계정 축만 두면 한 IP 가 계정을 갈아 가며 scrypt 를 갈아 넣는 것을
 * 못 막는다. 검증 자체가 비싼(~30ms) 경로라 후자는 CPU 고갈로 이어진다.
 * 이메일 찾기에는 scrypt 가 없다. 거기서 IP 축은 번호를 바꿔 가며 이름 · 생년월일을
 * 맞혀 보는 것을 늦춘다(번호 축은 번호마다 새 버킷이라 그것을 못 막는다).
 *
 * IP 는 `req.ip` 다. 직원 앱은 Next 서버(BFF)를 거쳐 오므로, `TRUST_PROXY` 에 그 주소를
 * 적어야 `req.ip` 가 `X-Forwarded-For` 의 클라이언트 IP 가 된다(`config/trust-proxy.ts`).
 * 비워 두면 BFF 의 주소 하나가 되어 모든 사용자가 한 IP 버킷을 쓴다.
 * - 로그인·재설정의 IP 한도는 1분에 60번이다. 접속이 30일 유지되므로 로그인은 드물고,
 *   한 IP 에 가장 몰리는 경우는 매장 와이파이에서 출근 때 함께 로그인하는 것이다
 *   (20명 × 2~3번 — 여유 없이 경계에 맞춘 값이라 매장이 커지면 다시 본다). 버킷은
 *   경로마다 따로라, 공격 IP 하나가 scrypt 를 쓰는 다섯 경로(직원 앱 넷 + 관리자 웹 회원가입)를 모두
 *   두드리면 코어 하나의 20% 안팎을 쓴다(관리자 링크의 저장 경로도 scrypt 를 쓰지만 sha256 으로 쓸 수 있는 링크를 찾은
 *   뒤에만 쓴다 — 토큰 없이는 태울 수 없어 셈에서 뺀다). 비밀번호
 *   대입은 이 축이 아니라 계정 축과 5회 잠금이 막는다.
 * - 갱신은 15분마다 모든 앱이 부르는 경로라, 로그인 한도를 그대로 쓰면 한 IP 를 나눠
 *   쓰는 사용자(매장 와이파이, 또는 `TRUST_PROXY` 가 비어 BFF 하나로 보일 때)가 늘수록
 *   서로를 막는다. 그래서 IP 한도를 `REFRESH_IP_LIMIT` 로 넉넉히 올린다. 빼 버리면
 *   토큰 축은 토큰마다 새 버킷이라 무작위 토큰을 무한히 보낼 수 있다.
 * - 로그아웃은 유효한 액세스 토큰이 있어야 닿는 경로라(전역 JWT 가드가 먼저 돈다)
 *   IP 축이 막을 것이 없어 뺀다(`@SkipThrottle({ ip: true })`).
 * - 이메일 찾기의 IP 한도는 1분에 30번이다(`EMAIL_FIND_IP_LIMIT`, `@Throttle`). scrypt 가 없어 로그인처럼 매장
 *   와이파이에서 몰릴 일이 적고, 이 축이 번호를 바꿔 가며 맞혀 보는 것을 늦추는 유일한 축이다(2026-10-13 재영).
 * - 관리자 웹 아이디 찾기도 IP 한도가 1분에 30번이라 같은 값을 쓴다(WHALEERP-398, 2026-10-20). 계정 축은 넣은
 *   이메일마다 새 버킷이라, 이메일을 바꿔 가며 이름을 맞혀 보는 것은 이 축만 늦춘다.
 *
 * ponytail: 저장소가 프로세스 메모리라 인스턴스마다 따로 센다. 여러 대로
 * 늘리면 한도가 대수만큼 늘어나므로, 그때 공용 저장소(Redis)로 바꾼다.
 */
export function ipTracker(req: Record<string, unknown>): string {
  const socket = req.socket as { remoteAddress?: string } | undefined;
  // 주소를 못 얻어도 던지지 않는다. 한 버킷에 묶이는 편이 무제한보다 낫다.
  return clientKey(req.ip) ?? clientKey(socket?.remoteAddress) ?? 'unknown';
}

/**
 * 버킷 키로 쓸 주소. trust proxy 가 켜지면 `req.ip` 는 X-Forwarded-For 에서 오므로
 * 포트(`1.2.3.4:5555`)나 대괄호가 붙어 있을 수 있어 뗀다. 그래도 주소가 아니면 null —
 * 헤더에 아무 글자나 넣어 새 버킷을 열지 못하게 소켓 주소로 떨어진다.
 *
 * IPv6 는 /64 로 묶는다. 회선 하나가 /64 를 통째로 받으므로, 주소마다 세면 한 호스트가
 * 요청마다 주소를 바꿔 IP 축을 없앨 수 있다. `::ffff:` 로 들어온 IPv4 는 IPv4 로 센다.
 */
function clientKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const address =
    /^\[([^\]]+)\](?::\d+)?$/.exec(raw)?.[1] ??
    /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw)?.[1] ??
    raw;
  if (isIPv4(address)) return address;
  const hextets = expandIpv6(address);
  if (!hextets) return null;
  if (isIpv4Mapped(hextets))
    return [
      hextets[6] >> 8,
      hextets[6] & 0xff,
      hextets[7] >> 8,
      hextets[7] & 0xff,
    ].join('.');
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(':')}::/64`;
}

/**
 * 계정 축. 경로가 아니라 요청에 실린 것으로 기준을 고른다 — 본문 이메일(직원 앱 · 관리자 아이디 찾기) → 본문
 * 로그인ID(관리자 웹) → 본문 휴대전화번호(이메일 찾기, HMAC) → 본문 갱신 토큰 → 본문 재설정 링크 토큰 →
 * Bearer 토큰 → IP 순이다.
 */
export function accountTracker(req: Record<string, unknown>): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  // 로그인은 소문자로 정규화해 조회한다. 카운트 키가 다르면 대소문자만
  // 바꿔 가며 제한을 우회할 수 있다.
  if (typeof email === 'string' && email.trim())
    return `account:${email.trim().toLowerCase()}`;
  // 관리자 로그인ID 는 대소문자를 구분하지만, 키는 소문자로 묶는다. 나누면 대소문자만 바꿔 한도를 늘린다.
  // 회원가입의 아이디 중복 확인(/auth/signup/login-id-availability)도 본문에 email 이 없어 여기서 센다.
  const loginId = (req.body as { loginId?: unknown } | undefined)?.loginId;
  if (typeof loginId === 'string' && loginId.trim())
    return `login-id:${loginId.trim().toLowerCase()}`;
  // 이메일 찾기는 이메일을 모르는 사람이 부르는 경로라 넣은 번호로 센다. 검증 전이라 숫자만 남긴다 —
  // 하이픈 · 공백만 바꿔 가며 제한을 우회하지 못하게.
  const phone = (req.body as { phone?: unknown } | undefined)?.phone;
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (digits) return `phone:${phoneBucketKey(digits)}`;
  // 갱신은 본문의 갱신 토큰, 재설정 링크는 본문 token, 로그아웃은 Bearer 토큰으로 센다. 원문 대신 해시를
  // 키로 쓴다 — 저장소의 키가 그대로 자격이 되지 않게.
  const token = bodyRefreshToken(req) ?? bodyLinkToken(req) ?? bearerToken(req);
  if (token) return `token:${hashToken(token)}`;
  // 셀 기준이 없는 요청을 상수 키로 묶으면 한 명이 전체를 막는다.
  return `ip:${ipTracker(req)}`;
}

/**
 * 로그인해야 닿는 경로의 계정 축. 전역 JWT 가드가 먼저 돌아 req.user 가 있으면 계정으로 센다 — 기본 계정 축은
 * Bearer 토큰으로 세는데, 접근 토큰은 15분마다 바뀌어 토큰마다 새 버킷이 된다. 없으면 accountTracker 다.
 */
export function signedInUserTracker(req: Record<string, unknown>): string {
  const user = req.user as { type?: unknown; id?: unknown } | undefined;
  if (typeof user?.type === 'string' && typeof user.id === 'number')
    return `${user.type}:${user.id}`;
  return accountTracker(req);
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

/** 관리자 초기화 재설정 링크의 토큰(WHALEERP-172). */
function bodyLinkToken(req: Record<string, unknown>): string | undefined {
  const token = (req.body as { token?: unknown } | undefined)?.token;
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

/** 이메일 찾기 경로의 IP 한도. 전역 IP 한도(60)보다 낮게 둔다 — 번호를 바꿔 가며 맞혀 보는 것을 늦추는 유일한 축이다. 관리자 아이디 찾기도 같은 값이다(WHALEERP-398). */
export const EMAIL_FIND_IP_LIMIT = { limit: 30, ttl: 60_000 };

export const AUTH_THROTTLERS: ThrottlerOptions[] = [
  { name: 'ip', ttl: 60_000, limit: 60, getTracker: ipTracker },
  { name: 'account', ttl: 600_000, limit: 10, getTracker: accountTracker },
];
