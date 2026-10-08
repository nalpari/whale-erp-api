import { readMailConfig } from './mail.config';

describe('readMailConfig', () => {
  const env: Record<string, string> = {
    MAIL_USERNAME: 'noreply@whale.test',
    MAIL_PASSWORD: 'abcd efgh ijkl mnop',
  };
  const read = (overrides: Record<string, string | undefined> = {}) =>
    readMailConfig((key) => ({ ...env, ...overrides })[key]);

  it('두 값을 읽는다. 앱 비밀번호 가운데 공백은 그대로 둔다', () => {
    expect(read()).toEqual({
      username: 'noreply@whale.test',
      password: 'abcd efgh ijkl mnop',
    });
  });

  it.each(['MAIL_USERNAME', 'MAIL_PASSWORD'])(
    '%s 가 비면 이름을 담아 던진다',
    (key) => {
      expect(() => read({ [key]: '  ' })).toThrow(key);
      expect(() => read({ [key]: undefined })).toThrow(key);
    },
  );
});
