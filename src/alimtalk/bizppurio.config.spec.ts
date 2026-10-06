import { readBizppurioConfig } from './bizppurio.config';

describe('readBizppurioConfig', () => {
  const env: Record<string, string> = {
    BIZPPURIO_BASE_URL: 'https://dev-api.bizppurio.com/',
    BIZPPURIO_ACCOUNT: 'whale',
    BIZPPURIO_PASSWORD: 'secret',
    BIZPPURIO_SENDER_KEY: 'sender-key',
  };
  const read = (overrides: Record<string, string | undefined> = {}) =>
    readBizppurioConfig((key) => ({ ...env, ...overrides })[key]);

  it('네 값을 읽고 base URL 끝의 / 를 뗀다', () => {
    expect(read()).toEqual({
      baseUrl: 'https://dev-api.bizppurio.com',
      account: 'whale',
      password: 'secret',
      senderKey: 'sender-key',
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
