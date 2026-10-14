import { adminWebLink, readAdminWebUrl } from './admin-web-url';

describe('readAdminWebUrl', () => {
  it.each([undefined, '', '   '])('비었으면(%p) null', (raw) => {
    expect(readAdminWebUrl(raw)).toBeNull();
  });

  it.each(['https://admin.example.com', 'http://localhost:3000'])(
    '웹 주소(%s)는 그대로',
    (raw) => {
      expect(readAdminWebUrl(` ${raw} `)).toBe(raw);
    },
  );

  it.each(['admin.example.com', 'javascript:alert(1)', 'ftp://x.test'])(
    '웹 주소가 아니면(%s) 기동 때 던진다',
    (raw) => {
      expect(() => readAdminWebUrl(raw)).toThrow('ADMIN_WEB_URL');
    },
  );
});

describe('readAdminWebUrl — 경로', () => {
  // 링크는 origin + 화면 경로다. 하위 경로에 배포한 주소를 받아 두면 첫 메일 때에야 링크가 깨진 것을 안다.
  it.each([
    'https://admin.example.com/admin',
    'https://admin.example.com/?x=1',
    'https://admin.example.com/#a',
  ])('경로 · 쿼리 · 조각이 붙은 주소(%s)는 기동 때 던진다', (raw) => {
    expect(() => readAdminWebUrl(raw)).toThrow('ADMIN_WEB_URL');
  });

  it('끝의 / 하나는 받는다', () => {
    expect(readAdminWebUrl('https://admin.example.com/')).toBe(
      'https://admin.example.com/',
    );
  });
});

describe('adminWebLink', () => {
  it('origin 에 화면 경로를 붙인다', () => {
    expect(
      adminWebLink('https://admin.example.com/', '/support/inquiries/7'),
    ).toBe('https://admin.example.com/support/inquiries/7');
  });
});
