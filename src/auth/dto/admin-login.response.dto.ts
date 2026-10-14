import { AdminLoginInfoBpDto } from './admin-login-info.response.dto';

export class AdminLoginAccountResponseDto {
  adminAccountId: number;
  loginId: string;
  name: string | null;
  /** 권한 유형 — 공통코드 `ROLE_TYPE`(PM · PA · BM · BA · FM · FA). */
  roleTypeCode: string;
  /** 소속 BP. front 는 로그인 뒤 브라우저에 두는 BP 데이터를 `bpCodeId` 로 구분한다. */
  bp: AdminLoginInfoBpDto;
  /** true 면 닫을 수 없는 강제 비밀번호 변경 팝업을 띄운다. */
  isPasswordChangeRequired: boolean;
}

export class AdminLoginResponseDto {
  /** Authorization: Bearer <accessToken> 으로 API 를 호출한다. 1시간 뒤 만료된다. */
  accessToken: string;
  /** 세션을 이어 갈 때 쓴다. 원문은 이 응답에만 있고 서버에는 해시만 남는다. */
  refreshToken: string;
  /** 마지막으로 사용한 때부터 1시간이 되는 시각. 임시 비밀번호로 들어왔으면 그 만료를 넘지 않는다. */
  refreshTokenExpiresAt: Date;
  account: AdminLoginAccountResponseDto;
}

export class AdminRefreshResponseDto {
  /** 새 접근 토큰. 1시간 뒤 만료된다. */
  accessToken: string;
  /** 갱신 토큰은 새로 주지 않는다. 쓰던 것의 새 만료 시각이다. */
  refreshTokenExpiresAt: Date;
}
