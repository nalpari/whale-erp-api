import { readStaffAppUrl, resetLinkOf } from './staff-app-url';

describe('readStaffAppUrl', () => {
  it('비었으면 null — 기동은 하고 링크 발송만 503 이 된다', () => {
    expect(readStaffAppUrl(undefined, false)).toBeNull();
    expect(readStaffAppUrl('  ', true)).toBeNull();
  });

  it('주소를 앞뒤 공백 없이 돌려준다', () => {
    expect(readStaffAppUrl(' http://localhost:3000 ', false)).toBe(
      'http://localhost:3000',
    );
  });

  it('운영에서는 https 만 받는다 — 링크에 토큰이 실린다', () => {
    expect(readStaffAppUrl('https://staff.whale-erp.com', true)).toBe(
      'https://staff.whale-erp.com',
    );
    expect(() => readStaffAppUrl('http://staff.whale-erp.com', true)).toThrow(
      'https',
    );
  });

  it('주소가 아니거나 웹 주소가 아니면 기동 때 던진다', () => {
    expect(() => readStaffAppUrl('staff.whale-erp.com', false)).toThrow();
    expect(() => readStaffAppUrl('whaleerp://reset', false)).toThrow();
  });
});

describe('resetLinkOf', () => {
  it('직원 앱의 재설정 링크 경로에 토큰을 fragment 로 붙인다 — 서버 접근 로그에 남지 않게', () => {
    expect(resetLinkOf('https://staff.whale-erp.com', 'abc_-1')).toBe(
      'https://staff.whale-erp.com/password-reset/link#token=abc_-1',
    );
  });

  it('끝 / 가 있어도 같은 주소다', () => {
    expect(resetLinkOf('https://staff.whale-erp.com/', 'x')).toBe(
      'https://staff.whale-erp.com/password-reset/link#token=x',
    );
  });
});
