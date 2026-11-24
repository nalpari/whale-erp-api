import { assertPresent } from './assert-present';

describe('assertPresent', () => {
  it('값이 있으면 그대로 준다 — 빈 문자열도 값이다', () => {
    expect(assertPresent('a@b.c', 'email')).toBe('a@b.c');
    expect(assertPresent('', 'email')).toBe('');
  });

  it('null 이면 칸 이름만 담아 던진다 — 값은 남기지 않는다', () => {
    expect(() => assertPresent(null, 'real_name')).toThrow(
      '탈퇴하지 않은 계정의 real_name 칸이 비어 있다',
    );
  });
});
