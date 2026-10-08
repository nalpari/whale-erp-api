export const BIZPPURIO_CONFIG = Symbol('BIZPPURIO_CONFIG');

export type BizppurioConfig = {
  /** 검수 https://dev-api.bizppurio.com · 운영 https://api.bizppurio.com */
  baseUrl: string;
  account: string;
  password: string;
  /** 카카오 알림톡 발신 프로필 키 */
  senderKey: string;
  /**
   * 알림톡이 실패해 문자로 대체 발송할 때의 발신번호(숫자만). 비즈뿌리오에 사전 등록된 번호.
   * null 이면 대체 발송을 하지 않는다 — 어떤 템플릿을 문자로 대체할지 기획이 정하기 전까지
   * 기본은 꺼짐이다.
   */
  smsFrom: string | null;
};

const KEYS = {
  baseUrl: 'BIZPPURIO_BASE_URL',
  account: 'BIZPPURIO_ACCOUNT',
  password: 'BIZPPURIO_PASSWORD',
  senderKey: 'BIZPPURIO_SENDER_KEY',
  smsFrom: 'BIZPPURIO_SMS_FROM',
} as const;

/**
 * 비즈뿌리오 설정을 읽는다. 기동 단계에서 부르며 발신번호 말고 하나라도 비거나 base URL 이
 * https URL 이 아니면 던진다. 그대로 떠 버리면 첫 발송 때에야 계정 오류나
 * 네트워크 오류로 드러나고, http 면 계정·비밀번호가 평문으로 나가기 때문이다.
 */
export function readBizppurioConfig(
  get: (key: string) => string | undefined,
): BizppurioConfig {
  const read = (key: string) => {
    const value = get(key)?.trim();
    if (!value)
      throw new Error(`${key} 가 비어 있습니다. .env.<APP_ENV> 를 확인하세요.`);
    return value;
  };
  const baseUrl = read(KEYS.baseUrl);
  if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== 'https:')
    throw new Error(`${KEYS.baseUrl} 는 https URL 이어야 합니다: ${baseUrl}`);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    account: read(KEYS.account),
    password: read(KEYS.password),
    senderKey: read(KEYS.senderKey),
    smsFrom: readSmsFrom(get(KEYS.smsFrom)?.trim()),
  };
}

// 0 으로 시작하는 9~11자리(지역번호 · 휴대폰) 또는 1 로 시작하는 8자리 대표번호(1588-…)
const SENDER_NUMBER = /^(0\d{8,10}|1\d{7})$/;

/**
 * 하이픈 등을 떼고 번호 모양인지 본다. 'N/A' 처럼 숫자가 없는 값이 빈 문자열로 통과하면
 * 알림톡은 접수되는데 대체 문자만 결과 리포트에서 조용히 거절된다.
 */
function readSmsFrom(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (!SENDER_NUMBER.test(digits))
    throw new Error(`${KEYS.smsFrom} 는 전화번호여야 합니다: ${value}`);
  return digits;
}
