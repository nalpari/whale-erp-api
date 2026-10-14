import { readAdminWebUrl } from './admin-web-url';

describe('readAdminWebUrl', () => {
  it('http(s) 주소를 끝의 / 를 떼고 돌려준다', () => {
    expect(readAdminWebUrl(' https://admin.whale.example/ ')).toBe(
      'https://admin.whale.example',
    );
    expect(readAdminWebUrl('http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
  });

  it.each([undefined, '', '   '])('비어 있으면 던진다: %p', (value) =>
    expect(() => readAdminWebUrl(value)).toThrow('ADMIN_WEB_URL 가 비어'),
  );

  it('http(s) 가 아니면 던진다', () =>
    expect(() => readAdminWebUrl('admin.whale.example')).toThrow(
      'ADMIN_WEB_URL 은 http(s) 주소여야 합니다',
    ));
});
