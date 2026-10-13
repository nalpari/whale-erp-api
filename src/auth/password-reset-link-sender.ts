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
 * 관리자 초기화 재설정 링크를 보내는 쪽(WHALEERP-172). 핀 발송기(`PasswordResetPinSender`)와 같은 자리다 —
 * MailModule 은 import 되는 순간 MAIL_* 가 비면 기동을 멈추고 지금 어느 환경에도 그 값이 없어, 메일 구현은
 * 팀이 MAIL_* 를 정한 뒤 이 자리에 꽂는다(2026-10-13 노영주).
 */
export abstract class PasswordResetLinkSender {
  /** 지금 실제로 보낼 수 있는지. false 면 발급은 503 이다 — 보내지 못하면서 보냈다고 답하지 않게. */
  abstract isAvailable(): boolean;

  abstract send(
    target: PasswordResetLinkTarget,
    mail: PasswordResetLinkMail,
  ): Promise<void>;
}
