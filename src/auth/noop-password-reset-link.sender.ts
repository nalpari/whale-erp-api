import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isProduction } from '../config/profile';
import {
  PasswordResetLinkSender,
  PasswordResetLinkTarget,
} from './password-reset-link-sender';

/**
 * 아무것도 보내지 않는 링크 발송기. 메일 구현이 꽂히기 전까지 연결해 둔다. 링크 · 토큰은 로그에도 남기지 않는다 —
 * 링크가 곧 비밀번호를 바꿀 권한이다. 운영에서는 쓸 수 없다고 답해 발급이 503 이 되게 하고, 기동은 막지 않는다
 * (핀 발송기 `NoopPasswordResetPinSender` 와 같다).
 */
@Injectable()
export class NoopPasswordResetLinkSender
  extends PasswordResetLinkSender
  implements OnModuleInit
{
  private readonly logger = new Logger(NoopPasswordResetLinkSender.name);

  onModuleInit(): void {
    if (isProduction())
      this.logger.error(
        '운영에 재설정 링크 발송기가 연결되지 않았다 — 관리자 초기화가 모두 503 이다',
      );
  }

  isAvailable(): boolean {
    return !isProduction();
  }

  send(target: PasswordResetLinkTarget): Promise<void> {
    this.logger.warn(
      `메일 발송기가 아직 없어 재설정 링크를 보내지 않았다 accountId=${target.accountId}`,
    );
    return Promise.resolve();
  }
}
