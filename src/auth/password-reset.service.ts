import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { validateNewPassword } from './password-policy';
import { PasswordResetPinSender } from './password-reset-pin-sender';
import { generatePin, normalizePin } from './pin';

/**
 * 핀 유효시간이자 새 비밀번호를 정하는 시간. 한 시계다 — 핀을 낸 시각부터 10분이 지나면 핀 확인도
 * 비밀번호 변경도 할 수 없다(2026-10-08 노영주). 둘을 따로 재려면 "핀을 맞힌 시각"을 저장할 칸이
 * 필요한데 `password_reset_pins` 에는 만료 시각뿐이다.
 */
const PIN_LIFETIME_MS = 10 * 60 * 1000;
/** 핀 하나로 틀릴 수 있는 횟수. 넘기면 그 핀은 닫힌다. 쿨다운은 두지 않는다(WHALEERP-170). */
const MAX_PIN_ATTEMPTS = 5;
const REISSUE_INTERVAL_MS = 60 * 1000;
const ISSUE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ISSUES_PER_WINDOW = 10;

// 틀림 · 만료 · 5회로 닫힘 · 이미 씀 · 없음 · 없는 계정을 구분해 알리지 않는다.
const INVALID_PIN_MESSAGE = '핀이 올바르지 않거나 만료되었습니다';

// 핀을 검증할 수 없을 때 대신 돌리는 검증용 해시. 어떤 값과도 맞지 않는다. 없으면 없는 계정이나
// 닫힌 핀은 scrypt 를 건너뛰어 즉시 거부되고, 그 시간차로 계정이 있는지 알 수 있다.
const DUMMY_HASH = hashPassword(randomBytes(32).toString('hex'));

type Outcome =
  | { kind: 'ok' }
  | { kind: 'unusable' }
  | { kind: 'wrong' }
  | { kind: 'rejected'; reason: string };

interface MatchedPin {
  account: { accountId: number; email: string };
  pinId: number;
  now: Date;
}

/** 직원 근무 앱 비밀번호 재설정 (WHALEERP-169 · 170 · 171). */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PasswordResetPinSender,
    private readonly sessions: AuthSessionService,
  ) {}

  /**
   * 핀을 낸다. 맞는 계정이 없어도, 간격이나 횟수 제한에 걸려도 똑같이 끝난다 — 응답이 갈리면
   * 그 이메일이 가입돼 있는지 알 수 있다. 제한에 걸리면 새 핀을 내지 않을 뿐이고, 앞서 낸 핀은
   * 만료 전까지 유효하다.
   */
  async requestPin(rawEmail: string): Promise<void> {
    const now = new Date();
    const email = rawEmail.trim().toLowerCase();
    const account = await this.prisma.account.findUnique({
      where: { email },
      select: { accountId: true, email: true, realName: true, status: true },
    });

    // 계정이 없어도 핀을 만들어 해시한다. 건너뛰면 걸린 시간으로 가입 여부를 알 수 있다.
    const pin = generatePin();
    const pinHash = await hashPassword(pin);
    // 탈퇴한 계정은 없는 계정으로 다룬다(ACC-15).
    if (!account || account.status === 'WITHDRAWN') return;

    const expiresAt = new Date(now.getTime() + PIN_LIFETIME_MS);
    const issued = await this.prisma.$transaction(async (tx) => {
      // 계정 행을 잠가 같은 계정의 발급이 한 번에 하나씩 지나가게 한다. 잠그지 않으면 동시에 눌린
      // 요청이 모두 "직전 발급 없음"을 읽고 간격과 하루 10회 제한을 넘는다.
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${account.accountId} FOR UPDATE`;

      const recent = await tx.passwordResetPin.findFirst({
        where: { accountId: account.accountId },
        orderBy: { issuedAt: 'desc' },
        select: { issuedAt: true },
      });
      if (
        recent &&
        now.getTime() - recent.issuedAt.getTime() < REISSUE_INTERVAL_MS
      )
        return false;

      const count = await tx.passwordResetPin.count({
        where: {
          accountId: account.accountId,
          issuedAt: { gte: new Date(now.getTime() - ISSUE_WINDOW_MS) },
        },
      });
      if (count >= MAX_ISSUES_PER_WINDOW) return false;

      // 새 핀을 내면 이전 핀은 바로 무효다. 사용 시각을 채워 닫는다 — 쓴 핀과 대체된 핀이
      // 같은 표시를 갖는다.
      await tx.passwordResetPin.updateMany({
        where: { accountId: account.accountId, usedAt: null },
        data: { usedAt: now },
      });
      await tx.passwordResetPin.create({
        data: {
          accountId: account.accountId,
          pinHash,
          issuedAt: now,
          expiresAt,
        },
      });
      return true;
    });
    if (!issued) return;

    // 저장이 끝난 뒤에 보낸다. 보내기에 실패해도 던지지 않는다 — 던지면 계정이 있다는 사실이
    // 드러난다. 사용자는 1분 뒤에 새 핀을 받을 수 있다.
    try {
      await this.sender.send(
        {
          accountId: account.accountId,
          email: account.email,
          realName: account.realName,
        },
        pin,
        expiresAt,
      );
    } catch (error) {
      this.logger.error(
        `핀 발송 실패 accountId=${account.accountId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** 핀이 맞는지만 확인한다. 상태는 바꾸지 않는다 — 틀렸을 때 횟수만 올린다. */
  async verifyPin(rawEmail: string, rawPin: string): Promise<void> {
    await this.checkPin(rawEmail, rawPin);
  }

  /**
   * 핀을 다시 검증하고 비밀번호를 바꾼다. 핀 확인과 같은 시도 횟수를 쓰고, 맞으면 한
   * 트랜잭션에서 비밀번호 변경 · 핀 소진 · 접속 종료 · 잠금 해제 · 이력까지 끝낸다.
   */
  async resetPassword(
    rawEmail: string,
    rawPin: string,
    newPassword: string,
  ): Promise<void> {
    await this.checkPin(
      rawEmail,
      rawPin,
      async (tx, { account, pinId, now }) => {
        // 규칙은 핀이 맞은 뒤에 본다. 핀이 틀렸는데 규칙 위반 사유를 주면 핀 없이도 규칙을 알아낼
        // 수 있다. 규칙에 어긋나면 핀을 소진하지 않고 횟수도 올리지 않아, 다시 정할 수 있다.
        const reason = validateNewPassword(newPassword, account.email);
        if (reason) return reason;

        const passwordHash = await hashPassword(newPassword);
        await tx.account.update({
          where: { accountId: account.accountId },
          data: { passwordHash, failedLoginCount: 0, lockExpiresAt: null },
        });
        await tx.passwordResetPin.update({
          where: { passwordResetPinId: pinId },
          data: { usedAt: now },
        });
        // 비밀번호만 바뀌고 다른 기기의 접속이 남는 순간이 없도록 같은 트랜잭션에서 끊는다.
        await this.sessions.revokeAll(account.accountId, tx);
        // 값은 남기지 않는다. 누가 어떤 경로로 바꿨는지만 남는다.
        await tx.accountChangeHistory.create({
          data: {
            accountId: account.accountId,
            field: 'PASSWORD',
            channel: 'PIN_RESET',
          },
        });
        return null;
      },
    );
  }

  /**
   * 핀 하나를 검증한다. 맞으면 `onMatch` 를 같은 트랜잭션에서 실행하고, 틀리면 횟수를 올린다.
   *
   * 계정 행을 잠그고 읽는다. 잠그지 않으면 동시에 들어온 틀린 시도가 모두 같은 횟수를 읽고 같은
   * 값을 써서 5회 제한을 병렬 요청으로 넘을 수 있다. 횟수를 올린 일은 거부해도 되돌려지면 안
   * 되므로, 트랜잭션 안에서는 던지지 않고 결과만 돌려준 뒤 밖에서 던진다.
   */
  private async checkPin(
    rawEmail: string,
    rawPin: string,
    onMatch?: (
      tx: Prisma.TransactionClient,
      matched: MatchedPin,
    ) => Promise<string | null>,
  ): Promise<void> {
    const now = new Date();
    const email = rawEmail.trim().toLowerCase();
    const pin = normalizePin(rawPin);
    const account = await this.prisma.account.findUnique({
      where: { email },
      select: { accountId: true, email: true, status: true },
    });
    if (!account || account.status === 'WITHDRAWN') {
      await this.equalizeTime(pin);
      throw new UnauthorizedException(INVALID_PIN_MESSAGE);
    }

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${account.accountId} FOR UPDATE`;

        // 가장 최근의 닫히지 않은 핀만 본다. 새 핀을 내면 이전 핀은 이미 닫혀 있다.
        const row = await tx.passwordResetPin.findFirst({
          where: { accountId: account.accountId, usedAt: null },
          orderBy: { issuedAt: 'desc' },
        });
        // 만료 시각과 같은 순간도 만료다.
        if (
          !row ||
          row.expiresAt.getTime() <= now.getTime() ||
          row.attemptCount >= MAX_PIN_ATTEMPTS
        )
          return { kind: 'unusable' };

        if (!(await verifyPassword(pin, row.pinHash))) {
          await tx.passwordResetPin.update({
            where: { passwordResetPinId: row.passwordResetPinId },
            data: { attemptCount: { increment: 1 } },
          });
          return { kind: 'wrong' };
        }

        const reason = onMatch
          ? await onMatch(tx, {
              account,
              pinId: row.passwordResetPinId,
              now,
            })
          : null;
        return reason ? { kind: 'rejected', reason } : { kind: 'ok' };
      },
    );

    if (outcome.kind === 'rejected')
      throw new BadRequestException(outcome.reason);
    if (outcome.kind === 'unusable') await this.equalizeTime(pin);
    if (outcome.kind === 'unusable' || outcome.kind === 'wrong')
      throw new UnauthorizedException(INVALID_PIN_MESSAGE);
  }

  /** 검증할 핀이 없을 때도 검증 한 번의 시간을 쓴다. */
  private async equalizeTime(pin: string): Promise<void> {
    await verifyPassword(pin, await DUMMY_HASH);
  }
}
