import { maskAccountNumber, maskRrn } from './personal-data-mask';

describe('maskRrn', () => {
  it('생년월일 6자리와 성별 자리만 남긴다', () => {
    expect(maskRrn('9803041234567')).toBe('980304-1******');
  });

  it('하이픈이 있어도 같다', () => {
    expect(maskRrn('980304-1234567')).toBe('980304-1******');
  });

  it('13자리 숫자가 아니면 던진다 — 깨진 값을 그럴듯하게 가려 내보내지 않는다', () => {
    expect(() => maskRrn('980304123456')).toThrow();
    expect(() => maskRrn('98030412345678')).toThrow();
    expect(() => maskRrn('980304123456a')).toThrow();
  });
});

describe('maskAccountNumber', () => {
  it('끝 4자리만 남기고 길이는 그대로', () => {
    expect(maskAccountNumber('110123456789')).toBe('********6789');
  });

  it('하이픈은 빼고 센다', () => {
    expect(maskAccountNumber('110-123-456789')).toBe('********6789');
  });

  it('숫자가 아니거나 5자리보다 짧으면 던진다', () => {
    expect(() => maskAccountNumber('1234')).toThrow();
    expect(() => maskAccountNumber('12a45678')).toThrow();
  });
});
