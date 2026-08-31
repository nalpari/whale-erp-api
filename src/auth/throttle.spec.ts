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

  it('이메일이 없는 요청은 IP 로 센다', () => {
    // 갱신 요청처럼 이메일이 없는 경로가 하나의 전역 버킷을 공유하면,
    // 한 명이 모두를 막을 수 있다.
    expect(accountTracker({ ip: '1.2.3.4', body: { refreshToken: 'x' } })).toBe(
      'ip:1.2.3.4',
    );
    expect(accountTracker({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    expect(accountTracker({ ip: '1.2.3.4', body: { email: 42 } })).toBe(
      'ip:1.2.3.4',
    );
  });
});
