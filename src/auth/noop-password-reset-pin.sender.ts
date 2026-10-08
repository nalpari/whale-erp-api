import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isProduction } from '../config/profile';
import {
  PasswordResetPinSender,
  PasswordResetPinTarget,
} from './password-reset-pin-sender';

/**
 * 아무것도 보내지 않는 발송기. 메일 발송 기반([API] 메일 발송 기반, WHALEERP-320)이 생기기 전까지
 * 연결해 둔다. 핀은 로그에도 남기지 않는다 — 핀이 곧 비밀번호를 바꿀 권한이다.
 *
 * 운영에서는 쓸 수 없다고 답해 핀 요청이 503 이 되게 한다. 기동을 막지는 않는다 — 발송기 하나
 * 때문에 로그인까지 내려가면 안 된다.
 */
@Injectable()
export class NoopPasswordResetPinSender
  extends PasswordResetPinSender
  implements OnModuleInit
{
  private readonly logger = new Logger(NoopPasswordResetPinSender.name);

  /** 운영에서 이 발송기로 떴으면 기동 때 한 번 남긴다. 요청마다 503 만으로는 배포 실수가 늦게 드러난다. */
  onModuleInit(): void {
    if (isProduction())
      this.logger.error(
        '운영에 비밀번호 재설정 핀 발송기가 연결되지 않았다 — 핀 요청이 모두 503 이다',
      );
  }

  isAvailable(): boolean {
    return !isProduction();
  }

  send(target: PasswordResetPinTarget): Promise<void> {
    this.logger.warn(
      `메일 발송 기반이 아직 없어 핀을 보내지 않았다 accountId=${target.accountId}`,
    );
    return Promise.resolve();
  }
}
