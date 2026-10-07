export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export type MailConfig = {
  /** Gmail 계정. 보낸 사람 주소도 이것이다 — Gmail 은 별칭으로 등록하지 않은 주소를 로그인한 계정으로 바꿔 쓴다. */
  username: string;
  /** 구글 계정의 앱 비밀번호(16자). 계정 비밀번호로는 SMTP 로그인이 안 된다. */
  password: string;
};

const KEYS = { username: 'MAIL_USERNAME', password: 'MAIL_PASSWORD' } as const;

/**
 * 메일 설정을 읽는다. 기동 단계에서 부르며 하나라도 비면 던진다. 그대로 떠 버리면
 * 첫 발송 때에야 로그인 오류로 드러난다. 값이 틀린 것(폐기된 앱 비밀번호 등)은
 * 여기서 알 수 없고, 첫 발송의 `mail FAILED … code=EAUTH` 로 드러난다.
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
  return {
    username: read(KEYS.username),
    // 구글은 앱 비밀번호를 4자씩 띄어 보여 주고, 그대로 붙여 넣는 일이 잦다.
    password: read(KEYS.password).replace(/\s/g, ''),
  };
}
