import { isIPv4, isIPv6 } from 'node:net';

/**
 * IPv6 주소를 16비트 여덟 칸으로 편다. 존 ID(`%eth0`)는 떼고, 끝에 적은 IPv4(`::ffff:1.2.3.4`)는
 * 두 칸으로 바꾼다. IPv6 가 아니면 null.
 */
export function expandIpv6(address: string): number[] | null {
  const bare = address.split('%')[0];
  if (!isIPv6(bare)) return null;

  let text = bare.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, rest] = text.split('::');
  const parse = (part: string | undefined) =>
    part ? part.split(':').map((h) => parseInt(h, 16)) : [];
  const left = parse(head);
  if (rest === undefined) return left;
  const right = parse(rest);
  return [
    ...left,
    ...Array<number>(8 - left.length - right.length).fill(0),
    ...right,
  ];
}

/** `::ffff:a.b.c.d` — IPv6 소켓으로 받은 IPv4 연결. */
export function isIpv4Mapped(hextets: number[]): boolean {
  return hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
}
