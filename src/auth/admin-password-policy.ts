/**
 * 관리자 웹 비밀번호 정책(1팀 PL-QSBSYY). 3팀 직원 앱 정책(`password-policy.ts`)과 다르다 — 관리자 계정은
 * 영문 · 숫자 · 정해진 특수문자를 각 1자 이상 담은 8~20자다. 문구는 정책의 「위반 안내 문구」 그대로이고 화면도
 * 같은 문구를 쓴다. 여러 조건을 어기면 정책 순서로 먼저 걸리는 하나만 알린다.
 */
export const ADMIN_PASSWORD_MESSAGES = {
  combination:
    '영문·숫자·특수문자를 각각 1자 이상 포함해 8~20자로 입력해 주세요.',
  sameAsLoginId: '비밀번호는 아이디와 다르게 설정해 주세요.',
  invalidCharacter: '사용할 수 없는 문자가 포함되어 있습니다.',
  sameAsCurrent: '현재 비밀번호와 다른 비밀번호를 입력해 주세요.',
  sameAsIssued: '발급받은 비밀번호와 다른 비밀번호를 입력해 주세요.',
  confirmMismatch: '새 비밀번호가 일치하지 않습니다.',
} as const;

// 허용 특수문자: ! @ # $ % ^ & * ( ) - _ = + [ ] { } ?
const SPECIAL = /[!@#$%^&*()\-_=+[\]{}?]/;
const ALLOWED = /^[A-Za-z0-9!@#$%^&*()\-_=+[\]{}?]*$/;

/**
 * 해시 대조 없이 볼 수 있는 앞 세 규칙(조합 · 길이 → 아이디 → 허용 문자). 현재 · 발급 비밀번호와 같은지와
 * 확인 값 일치는 그 뒤 순서라 부르는 쪽이 이어서 본다. 통과하면 null.
 */
export function validateAdminPassword(
  password: string,
  loginId: string,
): string | null {
  // 사용자가 보는 글자 수로 센다. length 는 UTF-16 단위라 이모지 하나를 두 글자로 센다.
  const length = [...password].length;
  if (
    length < 8 ||
    length > 20 ||
    !/[A-Za-z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !SPECIAL.test(password)
  )
    return ADMIN_PASSWORD_MESSAGES.combination;
  if (password === loginId) return ADMIN_PASSWORD_MESSAGES.sameAsLoginId;
  if (!ALLOWED.test(password)) return ADMIN_PASSWORD_MESSAGES.invalidCharacter;
  return null;
}
