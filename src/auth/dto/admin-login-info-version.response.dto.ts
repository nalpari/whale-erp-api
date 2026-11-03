/** 로그인 정보 버전(`GET /auth/admin/me/login-info-version`). */
export class AdminLoginInfoVersionResponseDto {
  /**
   * 로그인 정보 버전 — 이전에 받은 값과 다르면 login-info 를 다시 받는다. 형식은 정해 두지 않으니 비교에만 쓴다.
   * @example "k3J9xQ0b2nXyK1pV0aWmTg"
   */
  version: string;
}
