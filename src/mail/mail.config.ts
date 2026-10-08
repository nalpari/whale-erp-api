export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export type MailConfig = {
  /** Gmail 주소. 발신 주소로도 쓴다 */
  username: string;
  /** Gmail 앱 비밀번호(계정 비밀번호가 아니다) */
  password: string;
};

const KEYS = {
  username: 'MAIL_USERNAME',
  password: 'MAIL_PASSWORD',
} as const;

/**
 * 메일 설정을 읽는다. 기동 단계에서 부르며 하나라도 비면 던진다. 그대로 떠
 * 버리면 첫 발송 때에야 인증 오류로 드러난다.
 */
export function readMailConfig(
  get: (key: string) => string | undefined,
): MailConfig {
  const read = (key: string) => {
    const value = get(key)?.trim();
    if (!value)
      throw new Error(`${key} 가 비어 있습니다. .env.<APP_ENV> 를 확인하세요.`);
    return value;
  };
  return { username: read(KEYS.username), password: read(KEYS.password) };
}
