import { validateNewPassword } from '../auth/password-policy';
import { generateTempPassword } from './temp-password';

describe('generateTempPassword', () => {
  const samples = Array.from({ length: 200 }, () => generateTempPassword());

  it('12자다', () => {
    for (const s of samples) expect(s).toHaveLength(12);
  });

  // 읽어 옮겨 적는 값이다. 헷갈리는 글자(0 O o 1 l I)는 쓰지 않는다.
  it('헷갈리는 글자 없이 영문 대소문자 · 숫자만 쓴다', () => {
    for (const s of samples) expect(s).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
  });

  it('대문자 · 소문자 · 숫자를 하나씩은 꼭 넣어 새 비밀번호 규칙을 늘 통과한다', () => {
    for (const s of samples) {
      expect(s).toMatch(/[A-Z]/);
      expect(s).toMatch(/[a-z]/);
      expect(s).toMatch(/[0-9]/);
      expect(validateNewPassword(s, 'a@b.test')).toBeNull();
    }
  });

  it('매번 다르다', () => {
    expect(new Set(samples).size).toBe(samples.length);
  });
});
