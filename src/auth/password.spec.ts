import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('같은 비밀번호라도 매번 다른 해시를 만든다', async () => {
    const a = await hashPassword('pw12345!');
    const b = await hashPassword('pw12345!');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
  });

  it('올바른 비밀번호를 검증한다', async () => {
    expect(
      await verifyPassword('pw12345!', await hashPassword('pw12345!')),
    ).toBe(true);
  });

  it('틀린 비밀번호를 거부한다', async () => {
    expect(await verifyPassword('틀림', await hashPassword('pw12345!'))).toBe(
      false,
    );
  });

  it('깨진 저장값에 예외를 던지지 않고 false 를 준다', async () => {
    for (const broken of [
      '',
      'x',
      'scrypt$only-salt',
      'bcrypt$a$b',
      'scrypt$YQ==$YQ==',
    ]) {
      expect(await verifyPassword('pw12345!', broken)).toBe(false);
    }
  });
});
