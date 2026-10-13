export class PasswordResetLinkResponseDto {
  /** 링크를 보낸 시각 */
  issuedAt: Date;
  /** 링크가 쓸 수 없게 되는 시각 — 보낸 때부터 24시간 */
  expiresAt: Date;
}
