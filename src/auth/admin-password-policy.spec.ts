import {
  ADMIN_PASSWORD_MESSAGES,
  validateAdminPassword,
} from './admin-password-policy';

describe('validateAdminPassword (1팀 비밀번호 정책 PL-QSBSYY)', () => {
  const ok = 'Whale-2026!';
  const check = (password: string, loginId = 'whale01') =>
    validateAdminPassword(password, loginId);

  it('영문 · 숫자 · 허용 특수문자를 각 1자 이상 담은 8~20자면 통과', () => {
    expect(check(ok)).toBeNull();
    expect(check('a1!aaaaa')).toBeNull();
    expect(check('a1!' + 'a'.repeat(17))).toBeNull();
    expect(check('a1()-_=+[]{}?')).toBeNull();
  });

  it('조합 · 길이를 못 채우면 조합 문구', () => {
    for (const bad of [
      'a1!aaaa',
      'a1!' + 'a'.repeat(18),
      'abcdefg!',
      '1234567!',
      'abcd1234',
    ])
      expect(check(bad)).toBe(ADMIN_PASSWORD_MESSAGES.combination);
  });

  it('아이디와 같으면 아이디 문구', () => {
    expect(check('Whale01!x', 'Whale01!x')).toBe(
      ADMIN_PASSWORD_MESSAGES.sameAsLoginId,
    );
  });

  it('허용하지 않는 문자나 공백이 있으면 문자 문구', () => {
    expect(check('Whale 2026!')).toBe(ADMIN_PASSWORD_MESSAGES.invalidCharacter);
    expect(check('Whale2026!~')).toBe(ADMIN_PASSWORD_MESSAGES.invalidCharacter);
    expect(check('Whale2026!한')).toBe(
      ADMIN_PASSWORD_MESSAGES.invalidCharacter,
    );
  });

  it('여러 조건을 어기면 정책 순서로 먼저 걸리는 하나 — 조합 → 아이디 → 문자', () => {
    // 공백이 있어 조합도 문자도 걸리는 짧은 값은 조합이 먼저다.
    expect(check('a 1!')).toBe(ADMIN_PASSWORD_MESSAGES.combination);
    // 공백이 있고 아이디와도 같으면 아이디가 먼저다.
    expect(check('Whale 01!', 'Whale 01!')).toBe(
      ADMIN_PASSWORD_MESSAGES.sameAsLoginId,
    );
  });
});
