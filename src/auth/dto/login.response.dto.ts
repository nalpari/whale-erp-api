import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';

export class LoginAccountResponseDto {
  accountId: number;
  email: string;
  realName: string;
  /**
   * 가입 연결이 보류된 계정(`LINK_HOLD`)도 로그인된다. 이 값이 보류이면 앱은
   * 관리자 확인 중임을 보여 준다.
   */
  @ApiProperty({ enum: AccountStatus, enumName: 'AccountStatus' })
  status: AccountStatus;
}

export class LoginResponseDto {
  /** Authorization: Bearer <accessToken> 으로 API 를 호출한다. 15분 뒤 만료된다. */
  accessToken: string;
  /** 접속을 이어 갈 때 쓴다. 원문은 이 응답에만 있고 서버에는 해시만 남는다. */
  refreshToken: string;
  /** 마지막으로 사용한 때부터 30일(로그인 때 `rememberMe: false` 면 7일)이 되는 시각. 사용할 때마다 같은 길이로 뒤로 밀린다. */
  refreshTokenExpiresAt: Date;
  account: LoginAccountResponseDto;
}

/**
 * 429 본문. 같은 429 가 두 가지다 — `lockExpiresAt` 이 있으면 그 계정이 연속 5번 틀려 잠긴 것이고(앱은 남은 시간을
 * 보이고 그때까지 로그인을 막는다), 없으면 요청 제한(`throttle.ts` 의 `AUTH_THROTTLERS` — 같은 계정 축 · 같은 IP 축)에
 * 걸린 것이다. 이메일 찾기의 429(`EmailFindTooManyRequestsResponseDto`)와 같은 모양이다.
 */
export class LoginTooManyRequestsResponseDto {
  statusCode: number;
  message: string;
  /** 잠금의 429 에만 있다(`Too Many Requests`). 요청 제한의 429 본문은 `statusCode` · `message` 뿐이다. */
  error?: string;
  /** 계정 잠금이 풀리는 시각. 요청 제한의 429 에는 없다. */
  lockExpiresAt?: Date;
}
