import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// bcrypt/argon2 를 새로 들이지 않고 표준 라이브러리의 scrypt 를 쓴다.
// 저장 형식은 `scrypt$N$r$p$<salt-b64>$<key-b64>` 다. 파라미터를 저장값에
// 적어 두지 않으면 나중에 비용을 올리거나 Node 의 기본값이 바뀌는 순간
// 옛 해시를 재현할 방법이 없어져 전원이 잠긴다.
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// OWASP 권고 하한(N=2^14, r=8, p=1). Node 의 기본값과 같은 값이지만,
// 기본값에 기대지 않고 명시해 저장값과 항상 일치시킨다.
const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

const KEY_LENGTH = 64;

const derive = (
  password: string,
  salt: Buffer,
  { N, r, p }: ScryptParams,
): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    // maxmem 기본값은 32MB 다. N 이나 r 을 키우면 128*N*r 이 이를 넘어
    // 해싱이 실패하므로, 필요한 만큼 여유를 두고 함께 올린다.
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N, r, p, maxmem: 256 * N * r },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );

export async function hashPassword(
  plain: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, params);
  const { N, r, p } = params;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;

  const params = { N: Number(n), r: Number(r), p: Number(p) };
  // 숫자가 아니거나 0 이하면 scrypt 가 던진다. 여기서 걸러 500 을 막는다.
  if (Object.values(params).some((v) => !Number.isInteger(v) || v < 1))
    return false;

  const expected = Buffer.from(key, 'base64');
  // 길이가 다르면 timingSafeEqual 이 예외를 던진다.
  if (expected.length !== KEY_LENGTH) return false;

  const actual = await derive(plain, Buffer.from(salt, 'base64'), params);
  return timingSafeEqual(expected, actual);
}

/** 리프레시 토큰은 원문이 아니라 이 값으로 저장·대조한다. */
export function hashToken(token: string): string {
  // 토큰 자체가 이미 128비트 이상의 무작위 서명값이라, 비밀번호와 달리
  // 사전 공격 대상이 아니다. 느린 KDF 대신 sha256 으로 충분하다.
  return createHash('sha256').update(token).digest('hex');
}
