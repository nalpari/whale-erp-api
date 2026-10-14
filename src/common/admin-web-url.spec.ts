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

describe('adminWebLink', () => {
  it('기본 주소의 경로는 버리고 화면 경로를 붙인다', () => {
    expect(
      adminWebLink(
        'https://admin.example.com/ignored/',
        '/support/inquiries/7',
      ),
    ).toBe('https://admin.example.com/support/inquiries/7');
  });
});
