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

/**
 * 메일이 없어도 떠야 하는 곳(관리자 초기화 재설정 링크 · 직원 앱 이메일 변경 핀 · 플랫폼 관리자 · 문의 · 도입문의 · BP
 * 회원가입 메일)이 쓴다. 둘 다 비면 null — 기동하고 그 기능만 503 이다.
 * 하나만 있으면 readMailConfig 처럼 던진다: 반쯤 넣은 설정은 실수다.
 */
export function readOptionalMailConfig(
  get: (key: string) => string | undefined,
): MailConfig | null {
  const empty = Object.values(KEYS).every((key) => !get(key)?.trim());
  return empty ? null : readMailConfig(get);
}
