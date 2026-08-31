import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('같은 비밀번호라도 매번 다른 해시를 만든다', async () => {
    const a = await hashPassword('pw12345!');
    const b = await hashPassword('pw12345!');
    expect(a).not.toBe(b);
    // 파라미터(N/r/p)를 저장값에 남긴다. 없으면 나중에 비용을 올렸을 때
    // 옛 해시를 되살릴 방법이 없어 전원이 잠긴다.
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
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

  it('저장값에 적힌 파라미터로 검증한다', async () => {
    // 지금 기본값이 아닌 비용으로 만든 해시도 그대로 통과해야 한다.
    const stored = await hashPassword('pw12345!', { N: 1024, r: 8, p: 1 });
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await verifyPassword('pw12345!', stored)).toBe(true);
    expect(await verifyPassword('틀림', stored)).toBe(false);
  });

  it('깨진 저장값에 예외를 던지지 않고 false 를 준다', async () => {
    for (const broken of [
      '',
      'x',
      'scrypt$only-salt',
      'bcrypt$a$b',
      'scrypt$YQ==$YQ==',
      'scrypt$16384$8$1$YQ==$YQ==',
      'scrypt$안$8$1$YQ==$YQ==',
      'scrypt$0$8$1$YQ==$YQ==',
    ]) {
      expect(await verifyPassword('pw12345!', broken)).toBe(false);
    }
  });
});
