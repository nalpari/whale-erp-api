// 허용 문자는 영문·숫자와 이 특수문자뿐이다(공백·한글 불가). front 회원가입 화면의 검사와 같은
// 목록이라, 한쪽만 바꾸면 화면이 통과시킨 값을 서버가 거부한다.
const ALLOWED = /^[A-Za-z0-9!@#$%^&*()\-_=+[\]{}?]{8,20}$/;
const KINDS = [/[A-Za-z]/, /[0-9]/, /[!@#$%^&*()\-_=+[\]{}?]/];

/**
 * 관리자 웹 비밀번호 규칙. 회원가입 화면정의서(manyfast S-RCJXIG)의 「영문·숫자·특수문자 각 1자
 * 이상 8~20자」다. 직원 근무 앱의 `validateNewPassword`(WHALEERP-192, 종류 수에 따라 길이가
 * 갈린다)와 다른 규칙이라 함수를 따로 둔다 — 하나로 합치면 한쪽 화면의 안내와 어긋난다.
 *
 * @returns 받아도 되면 null, 아니면 사용자에게 보여 줄 사유
 */
export function validateAdminPassword(password: string): string | null {
  if (!ALLOWED.test(password) || !KINDS.every((kind) => kind.test(password)))
    return '영문·숫자·특수문자를 모두 포함해 8~20자로 입력해 주세요.';
  return null;
}
