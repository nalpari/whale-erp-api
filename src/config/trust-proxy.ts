import { isIP } from 'node:net';
import { NestExpressApplication } from '@nestjs/platform-express';
import { expandIpv6, isIpv4Mapped } from './ipv6';

// proxy-addr 가 이름으로 받는 미리 정해진 범위 — 127/8 · ::1, 169.254/16 · fe80::/10,
// 10/8 · 172.16/12 · 192.168/16 · fc00::/7.
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * `TRUST_PROXY` 를 읽어 Express `trust proxy` 값으로 바꾼다. 기동 단계에서 부르며,
 * 값이 잘못되면 던져서 서버가 뜨지 않게 한다.
 *
 * 받는 것은 믿을 프록시의 주소 목록뿐이다 — 쉼표로 나눈 IP, CIDR,
 * `loopback` · `linklocal` · `uniquelocal`. Express 는 오른쪽부터 이 목록에 든 주소를
 * 건너뛰고 처음 만난 다른 주소를 `req.ip` 로 삼으므로, 클라이언트가 앞에 지어 넣은
 * `X-Forwarded-For` 값은 닿지 않는다. 단, 클라이언트의 실제 주소가 목록에 들면 그 왼쪽
 * 값까지 믿게 되므로, 클라이언트도 있을 수 있는 대역보다 프록시 자신의 주소를 적는다.
 *
 * IPv4 를 담는 IPv6 블록(`::ffff:0:0/96`)에 걸치는 값도 받지 않는다. proxy-addr 는 IPv4
 * 연결을 IPv6 대역과 비교할 때 그 블록의 주소로 바꾸므로, `::/8` 이나 IPv6 안에 적은
 * `::ffff:10.0.0.0/8`(접두사를 128비트로 읽어 `::/8` 이 된다)은 IPv4 전체를 믿는다. IPv4
 * 연결이 `::ffff:` 로 들어와도 proxy-addr 가 IPv4 항목과 맞춰 주므로 IPv4 는 IPv4 로 적는다. 접두사 0 은
 * proxy-addr 가 영문 오류로 기동을 멈추므로 여기서 먼저 막는다.
 *
 * `true` 나 단계 수(`1`)는 받지 않는다. 주소를 보지 않고 믿는 값이라, api 에 프록시를
 * 거치지 않고 닿을 수 있으면 누구나 헤더로 IP 를 지어내 IP 축 요청 제한을 피한다.
 *
 * 비어 있으면 끈다(`false`). 프록시가 없는 곳에서는 소켓 주소가 곧 클라이언트다.
 */
export function readTrustProxy(value: string | undefined): string[] | false {
  if (!value?.trim()) return false;
  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries)
    if (!isTrustedProxyEntry(entry))
      throw new Error(
        `TRUST_PROXY 의 「${entry}」 는 주소가 아닙니다. ` +
          '믿을 프록시의 IP · CIDR · loopback · linklocal · uniquelocal 을 쉼표로 나눠 적으세요. ' +
          'true 나 단계 수는 받지 않습니다.',
      );
  return entries;
}

/**
 * 운영에서 `TRUST_PROXY` 가 비어 있으면 던져 기동을 막는다. 운영의 api 앞에는 관리자 웹 · 직원 앱의
 * Next 서버가 있으므로, 비어 있으면 모든 방문자가 그 서버 주소 한 버킷으로 세진다. 도입문의(시간당
 * 5건)는 여섯 번째 방문자부터 한 시간 동안 모두 막힌다(api #22, 2026-10-13 재영).
 */
export function assertTrustProxyForProduction(
  value: string | undefined,
  production: boolean,
): void {
  if (production && !value?.trim())
    throw new Error(
      '운영에서는 TRUST_PROXY 에 api 앞 프록시(Next 서버 · 로드밸런서)의 주소를 적어야 합니다. ' +
        '비어 있으면 모든 방문자가 한 IP 로 세져 요청 제한에 함께 걸립니다.',
    );
}

/** `main.ts` 와 e2e 가 같은 길로 trust proxy 를 건다. */
export function applyTrustProxy(
  app: NestExpressApplication,
  value: string | undefined,
): void {
  app.set('trust proxy', readTrustProxy(value));
}

function isTrustedProxyEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix !== undefined && !/^[0-9]{1,3}$/.test(prefix)) return false;
  const bits = prefix === undefined ? undefined : Number(prefix);
  if (bits !== undefined && (bits < 1 || bits > (version === 4 ? 32 : 128)))
    return false;
  if (version === 6) {
    const hextets = expandIpv6(address);
    if (address.includes('.') || !hextets || isIpv4Mapped(hextets))
      return false;
    if (bits !== undefined && bits <= 96 && coversIpv4Mapped(hextets, bits))
      return false;
  }
  return true;
}

/** 대역이 `::ffff:0:0/96` 을 품는가 — 앞 `bits` 비트가 그 블록과 같으면 품는다. */
function coversIpv4Mapped(hextets: number[], bits: number): boolean {
  const mapped = [0, 0, 0, 0, 0, 0xffff];
  for (let i = 0; i < 6 && bits > 0; i += 1, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((hextets[i] & mask) !== (mapped[i] & mask)) return false;
  }
  return true;
}
