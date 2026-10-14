import { createHmac } from 'node:crypto';

/** 같은 JWT 키로 다른 용도의 HMAC 을 만들 때 값이 겹치지 않게 앞에 붙인다. */
const PURPOSE = 'email-find-attempt:phone:';

/**
 * 이메일 찾기 시도를 묶는 휴대전화번호 키(`email_find_attempts.phone_key`). 원문을 남기지 않는다.
 * 번호는 경우의 수가 적어 단순 해시는 바로 되돌릴 수 있으므로 비밀 키로 HMAC 을 만든다.
 *
 * 키는 따로 두지 않고 JWT 키를 쓴다(2026-10-13 노영주). 새 환경변수가 필요 없고, JWT 키를 바꾸면
 * 시도 기록이 끊기지만 잠금이 최대 5분이라 잃는 것이 거의 없다. 대신 JWT 키가 새면 토큰 위조뿐 아니라 저장된
 * 번호 키도 번호를 다 넣어 보면 되돌릴 수 있게 된다 — 함께 받아들인 비용이다.
 */
export function phoneKeyOf(secret: string, phone: string): string {
  return createHmac('sha256', secret)
    .update(PURPOSE + phone)
    .digest('hex');
}
