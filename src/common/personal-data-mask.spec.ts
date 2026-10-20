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

describe('가림 실패', () => {
  const messageOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('던지지 않았다');
  };

  it('오류 메시지에 입력값을 싣지 않는다 — 로그로 원문이 새지 않게', () => {
    expect(messageOf(() => maskRrn('98030412345678'))).not.toMatch(/\d{4}/);
    expect(messageOf(() => maskAccountNumber('12-34'))).not.toMatch(/\d/);
  });

  it('계좌번호는 숫자 5자리부터 — 4자리는 다 보이게 되므로 던진다', () => {
    expect(maskAccountNumber('12345')).toBe('*2345');
    expect(() => maskAccountNumber('1234')).toThrow();
  });
});
