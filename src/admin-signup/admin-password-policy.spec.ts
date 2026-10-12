import { validateAdminPassword } from './admin-password-policy';

const MESSAGE = '영문·숫자·특수문자를 모두 포함해 8~20자로 입력해 주세요.';

describe('validateAdminPassword', () => {
  it.each(['whale-2026!', 'Abcdef1!', 'a1!a1!a1!a1!a1!a1!a1', 'Ab1[]{}?=+_'])(
    '영문·숫자·특수문자를 모두 쓴 8~20자는 받는다: %s',
    (password) => expect(validateAdminPassword(password)).toBeNull(),
  );

  it.each([
    ['특수문자 없음', 'whale2026'],
    ['숫자 없음', 'whale-whale!'],
    ['영문 없음', '2026-1234!'],
    ['7자', 'ab1!cd2'],
    ['21자', 'a1!' + 'a'.repeat(18)],
    ['공백', 'whale 2026!'],
    ['한글', 'whale2026!가'],
    ['허용 목록 밖 특수문자', 'whale2026~'],
  ])('%s이면 거부한다', (_, password) =>
    expect(validateAdminPassword(password)).toBe(MESSAGE),
  );

  it('8자와 20자는 받는다', () => {
    expect(validateAdminPassword('ab1!cd2e')).toBeNull();
    expect(validateAdminPassword('a1!' + 'a'.repeat(17))).toBeNull();
  });
});
