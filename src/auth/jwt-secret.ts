// HS256 은 키 길이를 강제하지 않는다. 한 글자짜리 키로도 서명과 검증이
// 그대로 되므로, 검사하지 않으면 평범한 토큰 하나만 손에 넣은 뒤 키를
// 무차별 대입으로 깨서 직원 토큰을 위조할 수 있다. 256비트가 하한이다.
const MIN_BYTES = 32;

/**
 * `JWT_SECRET` 을 읽어 검증한다. 기동 단계에서 부르며, 값이 부실하면
 * 던져서 서버가 뜨지 않게 한다. 약한 키로 도는 서버는 안 뜨는 서버보다 나쁘다.
 */
export function readJwtSecret(value: string | undefined): string {
  const secret = value?.trim() ?? '';
  if (Buffer.byteLength(secret, 'utf8') < MIN_BYTES)
    throw new Error(
      `JWT_SECRET 이 없거나 너무 짧습니다(${MIN_BYTES}바이트 이상 필요). ` +
        '.env.<APP_ENV> 를 확인하세요. 예) node -e ' +
        `"console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`,
    );
  return secret;
}
