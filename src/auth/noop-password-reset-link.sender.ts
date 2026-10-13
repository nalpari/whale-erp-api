import { Injectable, Logger } from '@nestjs/common';
import {
  PasswordResetLinkSender,
  PasswordResetLinkTarget,
} from './password-reset-link-sender';

/**
 * 메일 설정(`MAIL_*`)이 없을 때 꽂히는 링크 발송기. 어느 환경에서도 쓸 수 없다고 답해 발급이 503 이 된다 — 보내지
 * 못하면서 201 을 주면 직원이 받아 둔 핀 · 링크만 닫힌다(api #28 리뷰). 링크 · 토큰은 로그에도 남기지 않는다.
 * 운영 기동 로그는 링크 서비스가 남긴다.
 */
@Injectable()
export class NoopPasswordResetLinkSender extends PasswordResetLinkSender {
  private readonly logger = new Logger(NoopPasswordResetLinkSender.name);

  isAvailable(): boolean {
    return false;
  }

  send(target: PasswordResetLinkTarget): Promise<void> {
    this.logger.warn(
      `메일 설정이 없어 재설정 링크를 보내지 않았다 accountId=${target.accountId}`,
    );
    return Promise.reject(new Error('메일 설정이 없어 보낼 수 없다'));
  }
}
