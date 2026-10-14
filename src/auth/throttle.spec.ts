import { hashToken } from './password';
import { accountTracker, ipTracker } from './throttle';

describe('throttle trackers', () => {
  it('IP 는 req.ip 를, 없으면 소켓 주소를 쓴다', () => {
    expect(ipTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(ipTracker({ socket: { remoteAddress: '5.6.7.8' } })).toBe('5.6.7.8');
    // 둘 다 없어도 던지지 않는다. 하나의 버킷으로 묶여도 막히는 쪽이 낫다.
    expect(ipTracker({})).toBe('unknown');
  });

  it('IPv6 는 /64 로 묶는다 — 한 회선이 받는 대역 안에서 주소를 바꿔 가며 새 버킷을 열지 못하게', () => {
    expect(ipTracker({ ip: '2001:db8:1:2:aaaa::1' })).toBe('2001:db8:1:2::/64');
    expect(ipTracker({ ip: '2001:DB8:1:2:ffff:ffff:ffff:fffe' })).toBe(
      '2001:db8:1:2::/64',
    );
    expect(ipTracker({ ip: '2001:db8::1' })).toBe('2001:db8:0:0::/64');
    expect(ipTracker({ ip: 'fe80::1%eth0' })).toBe('fe80:0:0:0::/64');
  });

  it('IPv4 를 담은 IPv6 는 IPv4 로 센다 — 같은 사용자가 두 버킷을 갖지 않게', () => {
    expect(ipTracker({ ip: '::ffff:1.2.3.4' })).toBe('1.2.3.4');
  });

  it('X-Forwarded-For 에서 온 주소에 붙은 포트와 대괄호는 뗀다 — 출발 포트마다 버킷이 생기지 않게', () => {
    expect(ipTracker({ ip: '1.2.3.4:5555' })).toBe('1.2.3.4');
    expect(ipTracker({ ip: '[2001:db8::1]' })).toBe('2001:db8:0:0::/64');
    expect(ipTracker({ ip: '[2001:db8::1]:443' })).toBe('2001:db8:0:0::/64');
  });

  it('주소가 아닌 값은 소켓 주소로 센다 — 헤더에 아무 글자나 넣어 새 버킷을 열지 못하게', () => {
    expect(
      ipTracker({ ip: 'garbage', socket: { remoteAddress: '10.0.1.5' } }),
    ).toBe('10.0.1.5');
    expect(ipTracker({ ip: 'garbage' })).toBe('unknown');
  });

  it('계정 축은 정규화된 이메일로 센다', () => {
    // 로그인은 소문자로 정규화해 조회하므로 카운트도 같은 키여야 한다.
    // 대소문자만 바꿔 가며 던지면 제한을 우회할 수 있다.
    expect(
      accountTracker({ ip: '1.2.3.4', body: { email: ' Admin@Whale.TEST ' } }),
    ).toBe('account:admin@whale.test');
  });

  it('이메일이 없으면 정규화된 아이디로 센다 — login-id-availability 는 본문에 email 이 없다', () => {
    expect(
      accountTracker({ ip: '1.2.3.4', body: { loginId: ' Hangang01 ' } }),
    ).toBe('account:hangang01');
  });

  it('이메일 찾기는 휴대전화번호로 센다 — 이메일이 없는 요청이라 IP 로 떨어지면 공유 IP 에서 서로 막는다', () => {
    // 요청 제한은 검증 전에 돈다. 하이픈 · 공백만 다르게 넣어 제한을 우회하지 못하게 숫자만 남긴다.
    const key = accountTracker({
      ip: '1.2.3.4',
      body: { phone: ' 010-1234-5678 ' },
    });
    expect(key).toMatch(/^phone:[0-9a-f]{64}$/);
    expect(
      accountTracker({ ip: '5.6.7.8', body: { phone: '01012345678' } }),
    ).toBe(key);
    expect(
      accountTracker({ ip: '1.2.3.4', body: { phone: '01012345679' } }),
    ).not.toBe(key);
    // 원문도 단순 sha256 도 아니다 — 번호는 경우의 수가 적어 sha256 은 다 넣어 보면 되돌아간다.
    expect(key).not.toContain('01012345678');
    expect(key).not.toBe(`phone:${hashToken('01012345678')}`);
    expect(accountTracker({ ip: '1.2.3.4', body: { phone: '--' } })).toBe(
      'ip:1.2.3.4',
    );
  });

  it('재설정 링크는 본문 token 의 해시로 센다 — 저장소에 토큰 원문이 남지 않게', () => {
    const key = accountTracker({
      ip: '1.2.3.4',
      body: { token: 'link-secret' },
    });
    expect(key).toBe(`token:${hashToken('link-secret')}`);
    expect(key).not.toContain('link-secret');
  });

  it('갱신은 갱신 토큰으로 센다 — 프록시 뒤에서 모두가 한 IP 로 보여도 서로 막지 않게', () => {
    expect(accountTracker({ ip: '1.2.3.4', body: { refreshToken: 'x' } })).toBe(
      `token:${hashToken('x')}`,
    );
  });

  it('로그아웃은 Bearer 토큰으로 센다', () => {
    expect(
      accountTracker({
        ip: '1.2.3.4',
        headers: { authorization: 'Bearer abc.def' },
      }),
    ).toBe(`token:${hashToken('abc.def')}`);
  });

  it('Bearer 스킴은 대소문자를 가리지 않는다 — 가드와 같다(RFC 7235). 가리면 그 요청은 공유 IP 버킷으로 떨어진다', () => {
    for (const scheme of ['bearer', 'BEARER'])
      expect(
        accountTracker({
          ip: '1.2.3.4',
          headers: { authorization: `${scheme} abc.def` },
        }),
      ).toBe(`token:${hashToken('abc.def')}`);
  });

  it('토큰 원문은 키에 넣지 않는다 — 저장소에 남는 키가 곧 자격이 되지 않게', () => {
    const key = accountTracker({ body: { refreshToken: 'secret-token' } });
    expect(key).not.toContain('secret-token');
  });

  it('이메일도 토큰도 없는 요청은 IP 로 센다', () => {
    // 한 전역 버킷을 공유하면 한 명이 모두를 막을 수 있다.
    expect(accountTracker({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    expect(
      accountTracker({ ip: '1.2.3.4', headers: { authorization: 'Basic x' } }),
    ).toBe('ip:1.2.3.4');
    expect(accountTracker({ ip: '1.2.3.4', body: { email: 42 } })).toBe(
      'ip:1.2.3.4',
    );
  });
});
