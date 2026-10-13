import { maskEmail } from './email-mask';

describe('maskEmail', () => {
  it('@ 앞은 처음 2글자와 마지막 1글자만 보이고 나머지는 실제 길이만큼 가린다', () => {
    expect(maskEmail('steelgym@gmail.com')).toBe('st*****m@gmail.com');
  });

  it('4글자면 가운데 한 글자만 가린다', () => {
    expect(maskEmail('abcd@naver.com')).toBe('ab*d@naver.com');
  });

  it('3글자 이하면 첫 글자만 보인다', () => {
    expect(maskEmail('abc@naver.com')).toBe('a**@naver.com');
    expect(maskEmail('ab@naver.com')).toBe('a*@naver.com');
    expect(maskEmail('a@naver.com')).toBe('a@naver.com');
  });

  it('도메인은 그대로 둔다', () => {
    expect(maskEmail('minsu.kim@sub.example.co.kr')).toBe(
      'mi******m@sub.example.co.kr',
    );
  });

  it('@ 가 여럿이면 마지막 @ 를 경계로 본다 — 도메인에는 @ 가 올 수 없다', () => {
    expect(maskEmail('"a@b"@example.com')).toBe('"a**"@example.com');
  });

  it('@ 가 없거나 @ 앞이 비면 던진다 — 깨진 값을 그럴듯한 문자열로 보이지 않게', () => {
    expect(() => maskEmail('no-at-sign')).toThrow();
    expect(() => maskEmail('@example.com')).toThrow();
  });

  it('오류 메시지에 이메일 원문을 넣지 않는다', () => {
    expect(() => maskEmail('secret-id')).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('secret-id') as unknown,
      }),
    );
  });
});
