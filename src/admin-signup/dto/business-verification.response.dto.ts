export class BusinessVerificationResponseDto {
  /** 10분짜리 인증 토큰. 가입할 때 bizVerificationToken 으로 한 번 보낸다 */
  verificationToken: string;
}
