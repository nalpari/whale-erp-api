import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthSessionService,
  INVALID_SESSION_MESSAGE,
} from '../auth-session/auth-session.service';
import { applyNewPassword } from '../auth/apply-new-password';
import type { AccountUser } from '../auth/auth.types';
import { hashPassword, verifyPassword } from '../auth/password';
import { validateNewPassword } from '../auth/password-policy';
import { PrismaService } from '../prisma/prisma.service';

export const CURRENT_PASSWORD_MISMATCH_MESSAGE =
  '지금 비밀번호가 맞지 않습니다';

/**
 * 직원 앱 비밀번호 변경 (WHALEERP-192). 지금 비밀번호를 확인한 뒤 새 비밀번호로 바꾼다. 규칙은 가입 · 재설정과 같은
 * `validateNewPassword` 이고, 적용은 재설정과 같은 `applyNewPassword` 다 — 열린 재설정 핀 · 링크를 닫고, 이 기기만
 * 남긴 채 다른 기기의 접속을 끊는다(2026-10-20 노영주).
 *
 * 지금 비밀번호를 틀려도 로그인 실패 횟수는 세지 않는다 — 요청 한도만 건다(2026-10-20 노영주). 세면 내 정보에서
 * 몇 번 틀린 것으로 로그인이 잠긴다.
 */
@Injectable()
export class MyPasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionService,
  ) {}

  async change(
    user: Pick<AccountUser, 'id' | 'sid'>,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const accountId = user.id;
    const account = await this.prisma.account.findUnique({
      where: { accountId },
      select: { email: true, passwordHash: true, status: true },
    });
    if (!account || account.status === 'WITHDRAWN')
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);

    // 지금 비밀번호를 먼저 본다. 규칙 위반 사유를 먼저 주면 토큰만 가진 사람이 비밀번호 없이 규칙을 확인할 수 있다 —
    // 큰 일은 아니지만 재설정(핀이 맞은 뒤에 규칙)과 순서를 맞춘다.
    if (!(await verifyPassword(currentPassword, account.passwordHash)))
      throw new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE);
    const reason = validateNewPassword(newPassword, account.email);
    if (reason !== null) throw new BadRequestException(reason);
    // scrypt 는 잠금 밖에서 — 잠근 채 해시하면 같은 계정의 로그인 · 재설정이 그동안 줄을 선다.
    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      const locked = await tx.account.findUniqueOrThrow({
        where: { accountId },
        select: { passwordHash: true, status: true },
      });
      if (locked.status === 'WITHDRAWN')
        throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
      // 확인한 사이 재설정 · 다른 기기의 변경이 먼저 끝났으면, 확인한 비밀번호는 이미 지금 비밀번호가 아니다.
      if (locked.passwordHash !== account.passwordHash)
        throw new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE);
      await applyNewPassword(tx, this.sessions, {
        accountId,
        passwordHash,
        now: new Date(),
        channel: 'SELF',
        keepSessionId: user.sid,
      });
    });
  }
}
