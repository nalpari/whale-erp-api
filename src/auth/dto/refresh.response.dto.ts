export class RefreshResponseDto {
  /** Authorization: Bearer <accessToken> 으로 API 를 호출한다. 15분 뒤 만료된다. */
  accessToken: string;
  /**
   * 갱신 토큰은 새로 주지 않는다. 쓰던 것을 계속 쓰고, 이 시각이 마지막으로
   * 사용한 때부터 30일이 되는 새 만료 시각이다.
   */
  refreshTokenExpiresAt: Date;
}
