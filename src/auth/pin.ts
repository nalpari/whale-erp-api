import { randomInt } from 'node:crypto';

export const PIN_LENGTH = 6;

// 영문 대문자와 숫자 36자 — 6자리면 약 22억 가지다. 헷갈리는 0·O·1·I 를 빼면 사용성은 낫지만
// 가짓수가 절반으로 줄어(약 10억) 명세에 적은 수치와 어긋난다. 입력은 대소문자를 가리지 않는다.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 암호학적 난수로 낸다. Math.random 은 추측할 수 있어 쓰지 않는다. */
export function generatePin(): string {
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i += 1)
    pin += ALPHABET[randomInt(ALPHABET.length)];
  return pin;
}

/** 메일에서 옮겨 적다 생기는 공백과 대소문자 차이를 받아 준다. */
export function normalizePin(input: string): string {
  return input.trim().toUpperCase();
}
