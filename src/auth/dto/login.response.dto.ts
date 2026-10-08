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
  /** 마지막으로 사용한 때부터 30일이 되는 시각. 사용할 때마다 뒤로 밀린다. */
  refreshTokenExpiresAt: Date;
  account: LoginAccountResponseDto;
}
