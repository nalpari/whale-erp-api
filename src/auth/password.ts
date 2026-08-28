import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// bcrypt/argon2 를 새로 들이지 않고 표준 라이브러리의 scrypt 를 쓴다.
// 저장 형식은 `scrypt$<salt-b64>$<key-b64>` 로, 파라미터가 바뀌면 앞의
// 스킴 이름을 바꿔 옛 해시와 구분할 수 있게 남겨 둔다.
const derive = (password: string, salt: Buffer, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keylen, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

const KEY_LENGTH = 64;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;

  const expected = Buffer.from(key, 'base64');
  // 길이가 다르면 timingSafeEqual 이 예외를 던진다. 여기서 걸러 500 을 막는다.
  if (expected.length !== KEY_LENGTH) return false;

  const actual = await derive(plain, Buffer.from(salt, 'base64'), KEY_LENGTH);
  return timingSafeEqual(expected, actual);
}

/** 리프레시 토큰은 원문이 아니라 이 값으로 저장·대조한다. */
export function hashToken(token: string): string {
  // 토큰 자체가 이미 128비트 이상의 무작위 서명값이라, 비밀번호와 달리
  // 사전 공격 대상이 아니다. 느린 KDF 대신 sha256 으로 충분하다.
  return createHash('sha256').update(token).digest('hex');
}
