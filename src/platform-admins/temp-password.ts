import { randomInt } from 'node:crypto';

// 메일을 보고 옮겨 적는 값이라 헷갈리는 글자(0 O o 1 l I)는 뺀다.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT = '23456789';
const ALL = UPPER + LOWER + DIGIT;
const LENGTH = 12;

const pick = (chars: string) => chars[randomInt(chars.length)];

/**
 * 초기 · 초기화 비밀번호 12자(temporary_passwords). 대문자 · 소문자 · 숫자를 하나씩 넣어
 * 새 비밀번호 규칙(3가지 이상 8자 이상)을 늘 통과한다. 자리는 섞어 첫 세 글자로 종류를 알 수 없게 한다.
 */
export function generateTempPassword(): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)];
  while (chars.length < LENGTH) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
