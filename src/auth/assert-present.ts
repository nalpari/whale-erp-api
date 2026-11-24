/**
 * 탈퇴하지 않은 계정은 이메일 · 비밀번호 해시 · 실명 · 생년월일 · 휴대전화가 모두 있다(CHECK
 * `accounts_personal_required_unless_withdrawn`, WHALEERP-770). 탈퇴한 계정(칸이 null)을 먼저 상태로 거른 호출부가 타입을 좁힐 때만
 * 쓴다 — 칸이 비어 있으면 빈 문자열 같은 값으로 덮지 않고 던진다(어느 칸인지만 남기고 값은 남기지 않는다).
 */
export function assertPresent<T>(value: T | null, field: string): T {
  if (value === null)
    throw new Error(`탈퇴하지 않은 계정의 ${field} 칸이 비어 있다`);
  return value;
}
