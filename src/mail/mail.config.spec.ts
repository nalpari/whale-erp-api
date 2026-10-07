import { readMailConfig } from './mail.config';

describe('readMailConfig', () => {
  const env: Record<string, string> = {
    MAIL_USERNAME: 'noreply@example.com',
    MAIL_PASSWORD: 'abcdefghijklmnop',
  };
  const read = (overrides: Record<string, string | undefined> = {}) =>
    readMailConfig((key) => ({ ...env, ...overrides })[key]);

  it('계정과 앱 비밀번호를 읽는다', () => {
    expect(read()).toEqual({
      username: 'noreply@example.com',
      password: 'abcdefghijklmnop',
    });
  });

  it('구글이 보여 주는 대로 띄어 쓴 앱 비밀번호는 공백을 뺀다', () => {
    expect(read({ MAIL_PASSWORD: 'abcd efgh ijkl mnop' }).password).toBe(
      'abcdefghijklmnop',
    );
  });

  it.each(['MAIL_USERNAME', 'MAIL_PASSWORD'])(
    '%s 가 비면 이름을 담아 던진다',
    (key) => {
      expect(() => read({ [key]: '  ' })).toThrow(key);
      expect(() => read({ [key]: undefined })).toThrow(key);
    },
  );
});
