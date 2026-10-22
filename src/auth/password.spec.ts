import { dummyPasswordHash, hashPassword, verifyPassword } from './password';

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

  it("저장값이 정상 해시든 '!' · 깨진 값이든 같은 비용으로 scrypt 를 한 번 돈다", async () => {
    // 건너뛰면 '!' 계정(초기 · 초기화 비밀번호 대기)만 빨라져 응답 시간으로 아이디가 드러난다.
    // 시간을 재면 흔들리므로 호출 횟수와 비용(N · r · p)으로 본다 — 싼 scrypt 한 번도 시간 차이다.
    let calls: unknown[] = [];
    jest.resetModules();
    jest.doMock('node:crypto', () => {
      const actual =
        jest.requireActual<typeof import('node:crypto')>('node:crypto');
      return {
        ...actual,
        scrypt: (...args: unknown[]) => {
          const { N, r, p } = args[3] as { N: number; r: number; p: number };
          calls.push({ N, r, p });
          return Reflect.apply(actual.scrypt, actual, args) as void;
        },
      };
    });
    const fresh = jest.requireActual<typeof import('./password')>('./password');
    jest.dontMock('node:crypto');
    const stored = await fresh.hashPassword('pw12345!');
    await fresh.dummyPasswordHash();

    for (const value of [stored, '!', '', 'scrypt$0$8$1$YQ==$YQ==']) {
      calls = [];
      await fresh.verifyPassword('틀림', value);
      expect([value, calls]).toEqual([value, [{ N: 16384, r: 8, p: 1 }]]);
    }
  });

  describe('dummyPasswordHash', () => {
    it('저장 형식의 해시이고 어떤 입력과도 맞지 않는다', async () => {
      const dummy = await dummyPasswordHash();

      expect(dummy.startsWith('scrypt$')).toBe(true);
      await expect(verifyPassword('', dummy)).resolves.toBe(false);
      await expect(verifyPassword('password', dummy)).resolves.toBe(false);
    });

    it('계산이 실패하면 그 실패를 붙들지 않고 다음 호출에서 다시 계산한다', async () => {
      // 모듈 상태(캐시)를 이 테스트만의 것으로 하려고 따로 불러온다. scrypt 는 첫 호출만 실패시킨다.
      let calls = 0;
      jest.resetModules();
      jest.doMock('node:crypto', () => {
        const actual =
          jest.requireActual<typeof import('node:crypto')>('node:crypto');
        return {
          ...actual,
          scrypt: (...args: unknown[]) => {
            const callback = args[args.length - 1] as (e: Error) => void;
            calls += 1;
            if (calls === 1) return callback(new Error('scrypt failed'));
            return Reflect.apply(actual.scrypt, actual, args) as void;
          },
        };
      });
      const fresh =
        jest.requireActual<typeof import('./password')>('./password');
      jest.dontMock('node:crypto');

      await expect(fresh.dummyPasswordHash()).rejects.toThrow('scrypt failed');
      await expect(fresh.dummyPasswordHash()).resolves.toMatch(/^scrypt\$/);
    });

    it('한 번만 계산한다 — 부를 때마다 scrypt 를 두 번 돌리면 시간이 달라진다', async () => {
      await expect(dummyPasswordHash()).resolves.toBe(
        await dummyPasswordHash(),
      );
    });
  });
});
