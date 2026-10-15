export class SignupResponseDto {
  /**
   * 가입 완료 화면을 여는 토큰. 10분 동안만 쓸 수 있다. 액세스 토큰이 아니라 이것으로 API 를
   * 부를 수 없다 — 「웨일ERP 시작하기」가 이 토큰을 로그인 접속으로 바꾸는 API 는 관리자 웹 로그인과
   * 함께 만든다.
   */
  signupToken: string;
  /** 가입한 BP 상호명 */
  tradeName: string;
  /** 가입한 아이디(소문자로 정규화한 값) */
  loginId: string;
  /** 가입한 이메일(소문자로 정규화한 값). 가입 안내 메일이 가는 주소다 */
  email: string;
}
