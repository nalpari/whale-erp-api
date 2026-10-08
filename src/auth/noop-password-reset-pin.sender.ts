import { Injectable, Logger } from '@nestjs/common';
import {
  PasswordResetPinSender,
  PasswordResetPinTarget,
} from './password-reset-pin-sender';

/**
 * 아무것도 보내지 않는 발송기. 메일 발송 기반([API] 메일 발송 기반, WHALEERP-320)이 생기기 전까지
 * 연결해 둔다. 핀은 로그에도 남기지 않는다 — 핀이 곧 비밀번호를 바꿀 권한이다.
 */
@Injectable()
export class NoopPasswordResetPinSender extends PasswordResetPinSender {
  private readonly logger = new Logger(NoopPasswordResetPinSender.name);

  send(target: PasswordResetPinTarget): Promise<void> {
    this.logger.warn(
      `메일 발송 기반이 아직 없어 핀을 보내지 않았다 accountId=${target.accountId}`,
    );
    return Promise.resolve();
  }
}
