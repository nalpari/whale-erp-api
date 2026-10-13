import { createHash } from 'node:crypto';
import { phoneKeyOf } from './phone-key';

describe('phoneKeyOf', () => {
  const secret = 'x'.repeat(48);

  it('같은 번호 · 같은 키면 같은 값이다 — 시도 기록을 이 값으로 묶는다', () => {
    expect(phoneKeyOf(secret, '01012345678')).toBe(
      phoneKeyOf(secret, '01012345678'),
    );
  });

  it('번호가 다르면 다르다', () => {
    expect(phoneKeyOf(secret, '01012345678')).not.toBe(
      phoneKeyOf(secret, '01012345679'),
    );
  });

  it('키가 다르면 다르다 — 키 없이 번호만으로 만들 수 없다', () => {
    expect(phoneKeyOf(secret, '01012345678')).not.toBe(
      phoneKeyOf('y'.repeat(48), '01012345678'),
    );
  });

  it('원문도 단순 해시도 아니다 — 번호는 경우의 수가 적어 해시는 바로 되돌릴 수 있다', () => {
    const key = phoneKeyOf(secret, '01012345678');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('01012345678');
    expect(key).not.toBe(
      createHash('sha256').update('01012345678').digest('hex'),
    );
  });
});
