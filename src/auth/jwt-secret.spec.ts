import { readJwtSecret } from './jwt-secret';

describe('readJwtSecret', () => {
  const strong = 'a'.repeat(32);

  it('32바이트 이상이면 그대로 돌려준다', () => {
    expect(readJwtSecret(strong)).toBe(strong);
    expect(readJwtSecret(`  ${strong}  `)).toBe(strong);
  });

  it('없거나 비어 있으면 던진다', () => {
    for (const value of [undefined, '', '   ']) {
      expect(() => readJwtSecret(value)).toThrow(/JWT_SECRET/);
    }
  });

  it('짧은 키는 거절한다', () => {
    // HS256 은 어떤 길이의 키도 받아들인다. 1바이트짜리로도 서명·검증이
    // 되므로, 막지 않으면 토큰 하나만 손에 넣고 키를 깨서 위조할 수 있다.
    for (const weak of ['x', 'secret', 'a'.repeat(31)]) {
      expect(() => readJwtSecret(weak)).toThrow(/32/);
    }
  });

  it('멀티바이트 문자는 바이트 길이로 센다', () => {
    // '가'는 UTF-8 로 3바이트다. 11자면 33바이트라 통과해야 한다.
    expect(() => readJwtSecret('가'.repeat(11))).not.toThrow();
    expect(() => readJwtSecret('가'.repeat(10))).toThrow(/32/);
  });
});
