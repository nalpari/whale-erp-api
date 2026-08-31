import { ThrottlerOptions } from '@nestjs/throttler';

/**
 * 로그인·갱신 경로의 요청 제한.
 *
 * 두 축이 모두 필요하다. IP 축만 두면 봇넷이 한 계정을 나눠 두드리는 것을
 * 못 막고, 계정 축만 두면 한 IP 가 계정을 갈아 가며 scrypt 를 갈아 넣는 것을
 * 못 막는다. 검증 자체가 비싼(~30ms) 경로라 후자는 CPU 고갈로 이어진다.
 *
 * ponytail: 저장소가 프로세스 메모리라 인스턴스마다 따로 센다. 여러 대로
 * 늘리면 한도가 대수만큼 늘어나므로, 그때 공용 저장소(Redis)로 바꾼다.
 */
export function ipTracker(req: Record<string, unknown>): string {
  const socket = req.socket as { remoteAddress?: string } | undefined;
  // 주소를 못 얻어도 던지지 않는다. 한 버킷에 묶이는 편이 무제한보다 낫다.
  return (req.ip as string) ?? socket?.remoteAddress ?? 'unknown';
}

export function accountTracker(req: Record<string, unknown>): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  // 로그인은 소문자로 정규화해 조회한다. 카운트 키가 다르면 대소문자만
  // 바꿔 가며 제한을 우회할 수 있다.
  if (typeof email === 'string' && email.trim())
    return `account:${email.trim().toLowerCase()}`;
  // 이메일이 없는 경로(갱신)를 상수 키로 묶으면 한 명이 전체를 막는다.
  return `ip:${ipTracker(req)}`;
}

export const AUTH_THROTTLERS: ThrottlerOptions[] = [
  { name: 'ip', ttl: 60_000, limit: 30, getTracker: ipTracker },
  { name: 'account', ttl: 600_000, limit: 10, getTracker: accountTracker },
];
