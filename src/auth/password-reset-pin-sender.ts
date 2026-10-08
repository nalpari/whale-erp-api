/** 핀을 받는 사람. 이메일로 찾은 계정이다. */
export interface PasswordResetPinTarget {
  accountId: number;
  email: string;
  realName: string;
}

/**
 * 비밀번호 재설정 핀을 보내는 쪽. 메일 발송 기반([API] 메일 발송 기반, WHALEERP-320)이 생기면
 * 그 구현을 이 자리에 꽂는다. 서비스는 어떻게 보내는지 모른다 — 메일이든 문자든 같은 자리다.
 */
export abstract class PasswordResetPinSender {
  /**
   * 지금 핀을 실제로 보낼 수 있는지. false 면 핀 요청은 계정과 상관없이 503 이다 — 보내지
   * 못하면서 "보냈다"고 답하면 사용자는 오지 않을 메일을 기다린다.
   */
  abstract isAvailable(): boolean;

  abstract send(
    target: PasswordResetPinTarget,
    pin: string,
    expiresAt: Date,
  ): Promise<void>;
}
