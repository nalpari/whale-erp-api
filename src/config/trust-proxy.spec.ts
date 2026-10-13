import { readTrustProxy } from './trust-proxy';

describe('readTrustProxy', () => {
  it('비어 있으면 끈다 — 프록시가 없는 곳에서 X-Forwarded-For 를 믿으면 누구나 IP 를 지어낸다', () => {
    expect(readTrustProxy(undefined)).toBe(false);
    expect(readTrustProxy('')).toBe(false);
    expect(readTrustProxy('  ')).toBe(false);
  });

  it('쉼표로 나눈 주소 · CIDR · Express 이름 범위를 목록으로 돌려준다', () => {
    expect(
      readTrustProxy(' 10.0.1.5, 10.0.0.0/16 ,loopback,fd00::/8, ::1'),
    ).toEqual(['10.0.1.5', '10.0.0.0/16', 'loopback', 'fd00::/8', '::1']);
  });

  it.each(['true', '1', '2'])(
    '모두 믿거나 단계 수로 믿는 값(%s)은 받지 않는다 — 앞에서 지어낸 헤더까지 믿게 된다',
    (value) => {
      expect(() => readTrustProxy(value)).toThrow(/TRUST_PROXY/);
    },
  );

  it.each([
    '10.0.0.300',
    '10.0.0.0/33',
    '::1/129',
    'next-server',
    '10.0.0.0/',
    '*',
    'all',
  ])('주소가 아닌 값(%s)은 기동 단계에서 던진다', (value) => {
    expect(() => readTrustProxy(value)).toThrow(/TRUST_PROXY/);
  });

  it('빈 항목은 건너뛰지 않고 던진다 — 쉼표 실수가 조용히 범위를 바꾸지 않게', () => {
    expect(() => readTrustProxy('10.0.0.1,,10.0.0.2')).toThrow(/TRUST_PROXY/);
  });

  it.each([
    '::ffff:10.0.0.0/8',
    '::ffff:0:0/96',
    '::ffff:10.0.1.5',
    '::/8',
    '::/1',
    '0:0:0:0:0:ffff::/80',
  ])(
    'IPv4 를 담는 IPv6 블록(::ffff:0:0/96)에 걸치는 값(%s)은 받지 않는다 — proxy-addr 가 IPv4 연결을 그 블록으로 맞춰 IPv4 전체를 믿게 된다',
    (value) => {
      expect(() => readTrustProxy(value)).toThrow(/TRUST_PROXY/);
    },
  );

  it('그 블록에 걸치지 않는 IPv6 대역은 받는다', () => {
    expect(readTrustProxy('2001:db8::/32,fd00::/8,fe80::/10')).toEqual([
      '2001:db8::/32',
      'fd00::/8',
      'fe80::/10',
    ]);
  });

  it.each(['0.0.0.0/0', '10.0.0.0/0', '::/0'])(
    '접두사 0(%s)은 받지 않는다 — Express 가 영문 TypeError 로 기동을 멈추기 전에 여기서 막는다',
    (value) => {
      expect(() => readTrustProxy(value)).toThrow(/TRUST_PROXY/);
    },
  );
});
