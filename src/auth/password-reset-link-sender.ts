/** 링크를 받는 사람. 직원 레코드에 묶인 계정이다. */
export interface PasswordResetLinkTarget {
  accountId: number;
  email: string;
  realName: string;
}

/** 보낼 내용. 메일 템플릿 EMAIL_STAFF_RESET_LINK 의 변수(근무지 · 링크)와 발송 기록에 쓸 값이다. */
export interface PasswordResetLinkMail {
  /** 그 직원 레코드의 점포 이름 */
  storeName: string;
  /** 토큰이 실린 재설정 링크. 로그 · 발송 기록에 원문을 남기지 않는다 */
  link: string;
  expiresAt: Date;
  /** 요청 관리자(admin_accounts.admin_account_id) */
  requestedBy: number;
}

/**
 * 관리자 초기화 재설정 링크를 보내는 쪽(WHALEERP-172). `MAIL_*` 가 있으면 MailService 로 보내는
 * `MailPasswordResetLinkSender`, 없으면 쓸 수 없는 `NoopPasswordResetLinkSender` 가 꽂힌다
 * (`createPasswordResetLinkSender`).
 */
export abstract class PasswordResetLinkSender {
  /** 지금 실제로 보낼 수 있는지. false 면 발급은 503 이다 — 보내지 못하면서 보냈다고 답하지 않게. */
  abstract isAvailable(): boolean;

  /**
   * 보낸다. 실패하거나 나갔는지 모르면(SMTP 타임아웃) 던진다 — 서비스는 새 링크를 지우고 앞선 링크 · 핀은 닫지
   * 않는다. 메일이 실제로 나갔어도 직원은 「쓸 수 없는 링크」를 볼 뿐이고 받아 둔 것은 그대로 쓸 수 있다.
   * 오류 메시지 · 원인에 링크 · 토큰을 싣지 않는다 — 서비스가 실패를 오류 스택째 로그에 남긴다.
   */
  abstract send(
    target: PasswordResetLinkTarget,
    mail: PasswordResetLinkMail,
  ): Promise<void>;
}
