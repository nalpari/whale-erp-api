/**
 * 새 비밀번호 규칙 (WHALEERP-192). 가입 · 내 정보 변경 · 재설정 · 관리자 초기화 링크가 같이 쓴다.
 *
 * - 문자 종류는 영문 대문자 · 영문 소문자 · 숫자 · 특수문자 넷이다. 영문 대문자·소문자·숫자가 아닌
 *   모든 문자(공백, 한글 포함)를 특수문자로 센다.
 * - 3가지 이상 섞으면 8자 이상, 2가지만 쓰면 10자 이상, 1가지는 받지 않는다. 20자까지 받는다.
 * - 아이디로 쓰는 이메일과 같은 값, 이메일의 앞부분(@ 앞)과 같은 값은 받지 않는다. 대소문자는 가리지 않는다.
 *
 * 쓰던 비밀번호를 다시 쓰는 것은 막지 않고 주기적으로 바꾸게 강제하지도 않는다. 그래서 이 함수는
 * 이전 값을 받지 않는다.
 *
 * @returns 받아도 되면 null, 아니면 사용자에게 보여 줄 사유
 */
export function validateNewPassword(
  password: string,
  email: string,
): string | null {
  const lowered = password.toLowerCase();
  const loweredEmail = email.trim().toLowerCase();
  const localPart = loweredEmail.split('@')[0];
  if (lowered === loweredEmail || lowered === localPart)
    return '아이디로 쓰는 이메일이나 그 앞부분은 비밀번호로 쓸 수 없습니다';

  if (password.length > 20) return '비밀번호는 20자까지 쓸 수 있습니다';

  const kinds = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) =>
    kind.test(password),
  ).length;
  if (kinds < 2)
    return '영문 대문자·소문자·숫자·특수문자 중 2가지 이상을 섞어야 합니다';
  if (kinds === 2 && password.length < 10)
    return '2가지 종류만 쓰면 10자 이상이어야 합니다';
  if (kinds >= 3 && password.length < 8)
    return '3가지 이상 섞어도 8자 이상이어야 합니다';
  return null;
}
