import { generatePin, normalizePin, PIN_LENGTH } from './pin';

describe('pin', () => {
  describe('generatePin', () => {
    it('영문 대문자와 숫자 6자리다', () => {
      expect(PIN_LENGTH).toBe(6);
      for (let i = 0; i < 300; i += 1)
        expect(generatePin()).toMatch(/^[A-Z0-9]{6}$/);
    });

    it('매번 같은 값을 내지 않는다', () => {
      const pins = new Set(Array.from({ length: 200 }, () => generatePin()));
      expect(pins.size).toBeGreaterThan(190);
    });

    it('숫자와 영문자가 모두 나온다', () => {
      const all = Array.from({ length: 200 }, () => generatePin()).join('');
      expect(all).toMatch(/[0-9]/);
      expect(all).toMatch(/[A-Z]/);
    });
  });

  describe('normalizePin', () => {
    it('앞뒤 공백을 지우고 대문자로 바꾼다 — 메일에서 옮기다 생기는 차이를 받아 준다', () => {
      expect(normalizePin('  ab12cd \n')).toBe('AB12CD');
    });

    it('이미 정리된 값은 그대로 둔다', () => {
      expect(normalizePin('AB12CD')).toBe('AB12CD');
    });
  });
});
