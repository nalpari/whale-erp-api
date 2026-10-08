import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PasswordResetPin, Prisma } from '@prisma/client';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password';
import { CLEARED_ATTEMPT_STATE } from './attempt-lock';
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

const UNAVAILABLE_MESSAGE =
  '지금은 비밀번호 재설정 핀을 보낼 수 없습니다. 잠시 뒤에 다시 시도해 주세요';

type Outcome =
  | { kind: 'ok' }
  | { kind: 'unusable' }
  | { kind: 'wrong' }
  | { kind: 'rejected'; reason: string };

interface PinAccount {
  accountId: number;
  email: string;
}

interface MatchedPin {
  account: PinAccount;
  pinId: number;
  /** 잠금을 잡은 뒤의 시각. */
  now: Date;
}

/** 준비 결과. 거부 사유이거나, 잠금 안의 쓰기에 넘길 값이다. */
type Prepared<C> = { ok: false; reason: string } | { ok: true; context: C };

/** 핀이 맞았을 때 할 일. 느린 준비와 잠금 안의 쓰기를 나눈다. */
interface MatchHandler<C> {
  /**
   * 핀이 맞은 뒤, 잠금을 잡기 전에 부른다. 해시처럼 느린 일을 여기서 한다. 거부 사유는 바로 답하지
   * 않는다 — 잠금 안에서 핀이 아직 쓸 수 있다고 확인된 뒤에 400 으로 답하고, 핀은 그대로 둔다.
   */
  prepare(account: PinAccount): Promise<Prepared<C>>;
  /** 잠금 안에서, 핀이 아직 쓸 수 있다는 것을 다시 확인한 뒤에 부른다. */
  apply(
    tx: Prisma.TransactionClient,
    matched: MatchedPin,
    context: C,
  ): Promise<void>;
}

/** 시도해 볼 수 있는 핀인지. 만료 시각과 같은 순간도 만료다. */
function isUsable(
  row: PasswordResetPin | null,
  now: Date,
): row is PasswordResetPin {
  return (
    row !== null &&
    row.expiresAt.getTime() > now.getTime() &&
    row.attemptCount < MAX_PIN_ATTEMPTS
  );
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
    // 핀을 보낼 수 없으면(운영에 발송기가 연결되지 않음) 계정과 상관없이 거부한다. 204 로 답하면
    // 사용자는 오지 않을 메일을 기다린다. 계정을 찾기 전에 끊어야 응답이 계정 유무로 갈리지 않는다.
    if (!this.sender.isAvailable())
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);

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
    let issued: boolean;
    try {
      issued = await this.issuePin(account.accountId, pinHash, now, expiresAt);
    } catch (error) {
      // DB 오류도 204 로 끝낸다. 이 트랜잭션은 계정이 있을 때만 돌기 때문에, 500 이 나가면 그
      // 이메일이 가입돼 있다는 뜻이 된다. Prisma 오류(요청 · 연결)만 삼키고 코드 오류는 그대로 올린다.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) &&
        !(error instanceof Prisma.PrismaClientUnknownRequestError) &&
        !(error instanceof Prisma.PrismaClientInitializationError)
      )
        throw error;
      this.logger.error(
        `핀 저장 실패 accountId=${account.accountId}`,
        error.stack,
      );
      return;
    }
    if (!issued) return;

    // 저장이 끝난 뒤에 보내고, 끝나기를 기다리지 않는다. 기다리면 발송에 걸린 시간만큼 응답이
    // 늦어져 계정이 있다는 것이 드러나고, 실패를 던져도 마찬가지다. 사용자는 1분 뒤에 새 핀을
    // 받을 수 있다.
    const target = {
      accountId: account.accountId,
      email: account.email,
      realName: account.realName,
    };
    void Promise.resolve()
      .then(() => this.sender.send(target, pin, expiresAt))
      .catch((error: unknown) =>
        this.logger.error(
          `핀 발송 실패 accountId=${account.accountId}`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }

  /** 간격과 하루 횟수를 지키면 핀을 저장한다. 냈으면 true. */
  private issuePin(
    accountId: number,
    pinHash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // 계정 행을 잠가 같은 계정의 발급이 한 번에 하나씩 지나가게 한다. 잠그지 않으면 동시에 눌린
      // 요청이 모두 "직전 발급 없음"을 읽고 간격과 하루 10회 제한을 넘는다.
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;

      const recent = await tx.passwordResetPin.findFirst({
        where: { accountId },
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
          accountId,
          issuedAt: { gte: new Date(now.getTime() - ISSUE_WINDOW_MS) },
        },
      });
      if (count >= MAX_ISSUES_PER_WINDOW) return false;

      // 새 핀을 내면 이전 핀은 바로 무효다. 사용 시각을 채워 닫는다 — 쓴 핀과 대체된 핀이
      // 같은 표시를 갖는다.
      await tx.passwordResetPin.updateMany({
        where: { accountId, usedAt: null },
        data: { usedAt: now },
      });
      await tx.passwordResetPin.create({
        data: {
          accountId,
          pinHash,
          issuedAt: now,
          expiresAt,
        },
      });
      return true;
    });
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
    await this.checkPin<{ passwordHash: string }>(rawEmail, rawPin, {
      prepare: async (account) => {
        // 규칙은 핀이 맞은 뒤에 본다. 핀이 틀렸는데 규칙 위반 사유를 주면 핀 없이도 규칙을 알아낼
        // 수 있다. 규칙에 어긋나면 핀을 소진하지 않고 횟수도 올리지 않아, 다시 정할 수 있다.
        const reason = validateNewPassword(newPassword, account.email);
        if (reason !== null) return { ok: false, reason };
        return {
          ok: true,
          context: { passwordHash: await hashPassword(newPassword) },
        };
      },
      apply: async (tx, { account, pinId, now }, { passwordHash }) => {
        await tx.account.update({
          where: { accountId: account.accountId },
          data: {
            passwordHash,
            failedLoginCount: CLEARED_ATTEMPT_STATE.failedCount,
            lockExpiresAt: CLEARED_ATTEMPT_STATE.lockExpiresAt,
          },
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
      },
    });
  }

  /**
   * 핀 하나를 검증한다. 맞으면 `onMatch` 를 실행하고, 틀리면 횟수를 올린다.
   *
   * 검증(scrypt, 약 30ms)은 잠금 밖에서 한다. 잠근 채 검증하면 같은 계정의 요청이 그동안 줄을
   * 선다. 대신 계정 행을 잠근 뒤 핀을 다시 읽어, 검증한 그 핀이 아직 쓸 수 있을 때만 결과를
   * 반영한다. 잠그지 않고 반영하면 동시에 들어온 틀린 시도가 모두 같은 횟수를 읽고 같은 값을 써서
   * 5회 제한을 병렬 요청으로 넘을 수 있다. 여러 시도가 잠금 밖에서 동시에 검증돼도 반영은 한 번에
   * 하나씩이고, 5회가 찬 뒤의 결과는 맞았더라도 버린다.
   *
   * 횟수를 올린 일은 거부해도 되돌려지면 안 되므로, 트랜잭션 안에서는 던지지 않고 결과만 돌려준
   * 뒤 밖에서 던진다.
   */
  private async checkPin<C>(
    rawEmail: string,
    rawPin: string,
    onMatch?: MatchHandler<C>,
  ): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const pin = normalizePin(rawPin);
    const found = await this.prisma.account.findUnique({
      where: { email },
      select: { accountId: true, email: true, status: true },
    });
    if (!found || found.status === 'WITHDRAWN') {
      await this.equalizeTime(pin);
      throw new UnauthorizedException(INVALID_PIN_MESSAGE);
    }
    const account: PinAccount = {
      accountId: found.accountId,
      email: found.email,
    };

    // 가장 최근의 닫히지 않은 핀만 본다. 새 핀을 내면 이전 핀은 이미 닫혀 있다.
    const latestPin = (
      client: Pick<Prisma.TransactionClient, 'passwordResetPin'>,
    ) =>
      client.passwordResetPin.findFirst({
        where: { accountId: account.accountId, usedAt: null },
        orderBy: { issuedAt: 'desc' },
      });

    const candidate = await latestPin(this.prisma);
    if (!isUsable(candidate, new Date())) {
      await this.equalizeTime(pin);
      throw new UnauthorizedException(INVALID_PIN_MESSAGE);
    }
    const matched = await verifyPassword(pin, candidate.pinHash);
    const prepared =
      matched && onMatch ? await onMatch.prepare(account) : undefined;

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${account.accountId} FOR UPDATE`;
        // 시각은 잠금을 잡은 뒤에 잡는다. 기다린 사이에 만료된 핀을 살아 있는 것으로 보지 않게.
        const now = new Date();
        const row = await latestPin(tx);
        // 기다리는 사이 새 핀이 나왔거나, 쓰였거나, 만료됐거나, 다른 시도로 5회가 찼으면 이 검증
        // 결과는 쓸 데가 없다. 틀린 횟수도 올리지 않는다 — 새 핀의 횟수는 새 핀으로 센다.
        if (
          !isUsable(row, now) ||
          row.passwordResetPinId !== candidate.passwordResetPinId
        )
          return { kind: 'unusable' };

        if (!matched) {
          await tx.passwordResetPin.update({
            where: { passwordResetPinId: row.passwordResetPinId },
            data: { attemptCount: { increment: 1 } },
          });
          return { kind: 'wrong' };
        }

        if (prepared && !prepared.ok)
          return { kind: 'rejected', reason: prepared.reason };
        if (onMatch && prepared)
          await onMatch.apply(
            tx,
            { account, pinId: row.passwordResetPinId, now },
            prepared.context,
          );
        return { kind: 'ok' };
      },
    );

    switch (outcome.kind) {
      case 'ok':
        return;
      case 'rejected':
        throw new BadRequestException(outcome.reason);
      case 'unusable':
      case 'wrong':
        throw new UnauthorizedException(INVALID_PIN_MESSAGE);
      default: {
        const unhandled: never = outcome;
        throw new Error(`처리하지 않은 결과: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** 검증할 핀이 없을 때도 검증 한 번의 시간을 쓴다. */
  private async equalizeTime(pin: string): Promise<void> {
    await verifyPassword(pin, await dummyPasswordHash());
  }
}
