export class BpBusinessVerificationResponseDto {
  /** 10분짜리 인증 토큰. 「저장」(PATCH /me/bp)의 businessVerificationToken 으로 그대로 보낸다 —
   * 그래야 세 값이 실제로 반영된다(점포 사업자정보와 같은 패턴). */
  verificationToken: string;
}
