export class EmailFindResponseDto {
  /**
   * 맞는 계정의 로그인 이메일을 가린 것. 휴대전화번호는 고유하지 않아 여럿일 수 있고(탈퇴 계정은 뺀다),
   * 가입 순서대로다. @ 앞은 처음 2글자와 마지막 1글자만 보이고(3글자 이하면 첫 글자만), 도메인은 그대로다.
   * 예: st*****m@gmail.com
   */
  emails: string[];
}

/**
 * 429 본문. 같은 429 가 두 가지다 — `lockExpiresAt` 이 있으면 그 휴대전화번호가 5번 틀려 막힌 것이고(앱은 남은
 * 시간을 보이고 입력을 잠근다), 없으면 요청 제한(`throttle.ts` 의 `AUTH_THROTTLERS` — 같은 번호 축 · 같은 IP 축)에
 * 걸린 것이다.
 */
export class EmailFindTooManyRequestsResponseDto {
  statusCode: number;
  message: string;
  error: string;
  /** 번호 잠금이 풀리는 시각. 요청 제한의 429 에는 없다. */
  lockExpiresAt?: Date;
}
