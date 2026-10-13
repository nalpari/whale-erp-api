/**
 * 이메일 찾기 결과에 보이는 이메일. @ 앞은 처음 2글자와 마지막 1글자만 보이고 나머지는 실제 길이만큼
 * `*` 다. 3글자 이하면 첫 글자만 보인다. 도메인은 그대로다(WHALEERP-178, 2026-10-13 노영주).
 * 예: steelgym@gmail.com → st*****m@gmail.com
 *
 * 글자는 코드 포인트로 센다. 로그인 이메일(`accounts.email`)처럼 @ 가 있고 그 앞이 비지 않은 값만 받는다 —
 * 아니면 던진다. 깨진 값을 그럴듯한 가림 문자열로 보이면 데이터가 잘못된 것을 아무도 모른다.
 */
export function maskEmail(email: string): string {
  // 도메인에는 @ 가 올 수 없어 마지막 @ 가 경계다.
  const at = email.lastIndexOf('@');
  // 원문은 메시지에 넣지 않는다 — 오류 로그에 이메일이 남는다.
  if (at <= 0)
    throw new Error('가릴 수 없는 이메일: @ 가 없거나 @ 앞이 비었다');
  const local = [...email.slice(0, at)];
  const domain = email.slice(at);
  const shown =
    local.length <= 3
      ? local[0] + '*'.repeat(local.length - 1)
      : local.slice(0, 2).join('') +
        '*'.repeat(local.length - 3) +
        local[local.length - 1];
  return shown + domain;
}
