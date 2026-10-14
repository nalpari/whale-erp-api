import { adminWebLink, readOptionalAdminWebUrl } from './admin-web-url';

describe('readOptionalAdminWebUrl', () => {
  it.each([undefined, '', '   '])('비었으면(%p) null', (raw) => {
    expect(readOptionalAdminWebUrl(raw, false)).toBeNull();
  });

  it.each([
    ['https://admin.example.com', 'https://admin.example.com'],
    [' https://admin.example.com/ ', 'https://admin.example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    // 하위 경로에 배포한 관리자 웹도 받는다 — 링크는 이 경로 뒤에 화면 경로를 붙인다.
    ['https://admin.example.com/console/', 'https://admin.example.com/console'],
  ])('%p 는 끝의 / 를 떼고 받는다', (raw, expected) => {
    expect(readOptionalAdminWebUrl(raw, false)).toBe(expected);
  });

  it.each(['admin.example.com', 'javascript:alert(1)', 'ftp://x.test'])(
    'http(s) 주소가 아니면(%s) 기동 때 던진다',
    (raw) => {
      expect(() => readOptionalAdminWebUrl(raw, false)).toThrow(
        'ADMIN_WEB_URL 은 http(s) 주소여야 합니다',
      );
    },
  );

  it('운영에서는 https 만 받는다', () => {
    expect(() =>
      readOptionalAdminWebUrl('http://admin.example.com', true),
    ).toThrow('운영에서 ADMIN_WEB_URL 은 https 여야 합니다');
    expect(readOptionalAdminWebUrl('https://admin.example.com', true)).toBe(
      'https://admin.example.com',
    );
  });
});

describe('adminWebLink', () => {
  it('주소 뒤에 화면 경로를 붙인다', () => {
    expect(
      adminWebLink('https://admin.example.com', '/support/inquiries/7'),
    ).toBe('https://admin.example.com/support/inquiries/7');
  });

  it('주소의 경로를 버리지 않는다', () => {
    expect(
      adminWebLink('https://admin.example.com/console', '/support/inquiries/7'),
    ).toBe('https://admin.example.com/console/support/inquiries/7');
  });
});
