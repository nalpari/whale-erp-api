import { readBizppurioConfig } from './bizppurio.config';

describe('readBizppurioConfig', () => {
  const env: Record<string, string> = {
    BIZPPURIO_BASE_URL: 'https://dev-api.bizppurio.com/',
    BIZPPURIO_ACCOUNT: 'whale',
    BIZPPURIO_PASSWORD: 'secret',
    BIZPPURIO_SENDER_KEY: 'sender-key',
    BIZPPURIO_SMS_FROM: '02-6928-0028',
  };
  const read = (overrides: Record<string, string | undefined> = {}) =>
    readBizppurioConfig((key) => ({ ...env, ...overrides })[key]);

  it('다섯 값을 읽고 base URL 끝의 / 와 발신번호의 하이픈을 뗀다', () => {
    expect(read()).toEqual({
      baseUrl: 'https://dev-api.bizppurio.com',
      account: 'whale',
      password: 'secret',
      senderKey: 'sender-key',
      smsFrom: '0269280028',
    });
  });

  it.each([
    'BIZPPURIO_BASE_URL',
    'BIZPPURIO_ACCOUNT',
    'BIZPPURIO_PASSWORD',
    'BIZPPURIO_SENDER_KEY',
  ])('%s 가 비면 이름을 담아 던진다', (key) => {
    expect(() => read({ [key]: '  ' })).toThrow(key);
    expect(() => read({ [key]: undefined })).toThrow(key);
  });

  it('발신번호가 비면 문자 대체 발송을 끈다(smsFrom null) — 기동은 막지 않는다', () => {
    expect(read({ BIZPPURIO_SMS_FROM: '  ' }).smsFrom).toBeNull();
    expect(read({ BIZPPURIO_SMS_FROM: undefined }).smsFrom).toBeNull();
  });

  it.each(['N/A', '-', '1588', '02-6928-00281234'])(
    '발신번호가 숫자만 남겨 전화번호 모양이 아니면(%s) 기동 단계에서 던진다',
    (smsFrom) => {
      // 그대로 뜨면 알림톡은 접수되고 대체 문자만 조용히 거절된다.
      expect(() => read({ BIZPPURIO_SMS_FROM: smsFrom })).toThrow(
        'BIZPPURIO_SMS_FROM',
      );
    },
  );

  it.each(['dev-api.bizppurio.com', 'http://dev-api.bizppurio.com'])(
    'base URL 이 https URL 이 아니면(%s) 기동 단계에서 던진다',
    (baseUrl) => {
      // 스킴이 없으면 매 발송이 네트워크 오류로 보이고, http 면 계정이 평문으로 나간다.
      expect(() => read({ BIZPPURIO_BASE_URL: baseUrl })).toThrow(
        'BIZPPURIO_BASE_URL',
      );
    },
  );
});
