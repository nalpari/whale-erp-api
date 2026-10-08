import { hashToken } from './password';
import { accountTracker, ipTracker } from './throttle';

describe('throttle trackers', () => {
  it('IP 는 req.ip 를, 없으면 소켓 주소를 쓴다', () => {
    expect(ipTracker({ ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(ipTracker({ socket: { remoteAddress: '5.6.7.8' } })).toBe('5.6.7.8');
    // 둘 다 없어도 던지지 않는다. 하나의 버킷으로 묶여도 막히는 쪽이 낫다.
    expect(ipTracker({})).toBe('unknown');
  });

  it('계정 축은 정규화된 이메일로 센다', () => {
    // 로그인은 소문자로 정규화해 조회하므로 카운트도 같은 키여야 한다.
    // 대소문자만 바꿔 가며 던지면 제한을 우회할 수 있다.
    expect(
      accountTracker({ ip: '1.2.3.4', body: { email: ' Admin@Whale.TEST ' } }),
    ).toBe('account:admin@whale.test');
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
