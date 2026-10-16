export class SignupBusinessVerificationResponseDto {
  /** 10분짜리 인증 토큰. 그 안에 가입 요청의 bizVerificationToken 으로 보낸다 */
  verificationToken: string;
}
