import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { EmailChangePin, Prisma } from '@prisma/client';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import { hashPassword, verifyPassword } from '../auth/password';
import { generatePin, normalizePin } from '../auth/pin';
import { isProduction } from '../config/profile';
import { errorKind } from '../mail/error-kind';
import { isMailTransportError } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailChangePinSender } from './email-change-pin-sender';
import { CURRENT_PASSWORD_MISMATCH_MESSAGE } from './my-password.service';

/** 템플릿 `EMAIL_CHANGE_PIN` 문구가 15분이다 */
const PIN_LIFETIME_MS = 15 * 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const REISSUE_INTERVAL_MS = 60 * 1000;
const ISSUE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ISSUES_PER_WINDOW = 10;

export const EMAIL_IN_USE_MESSAGE = '이미 쓰고 있는 이메일입니다.';
// 틀림 · 만료 · 5회로 닫힘 · 새 핀으로 대체 · 없음을 가르지 않는다. 본인 토큰으로만 닿는 경로라 숨길 것은 없지만, 화면이
// 할 일(새 핀 받기)이 모두 같다.
export const INVALID_EMAIL_CHANGE_PIN_MESSAGE =
  '핀이 올바르지 않거나 만료되었습니다.';
const UNAVAILABLE_MESSAGE =
  '지금은 인증 메일을 보낼 수 없습니다. 잠시 뒤에 다시 시도해 주세요.';

type Outcome =
  | { kind: 'ok' }
  | { kind: 'unusable' }
  | { kind: 'wrong' }
  | { kind: 'in_use' };

/** 시도해 볼 수 있는 핀인지. 만료 시각과 같은 순간도 만료다 */
function isUsable(
  row: EmailChangePin | null,
  now: Date,
): row is EmailChangePin {
  return (
    row !== null &&
    row.expiresAt.getTime() > now.getTime() &&
    row.attemptCount < MAX_PIN_ATTEMPTS
  );
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * 직원 앱 이메일 아이디 변경 (WHALEERP-191). 지금 비밀번호를 확인한 뒤 새 이메일로 핀을 보내고, 그 핀을 맞힌 뒤에만 계정 이메일(로그인 아이디)을
 * 바꾼다. 핀 규칙은 비밀번호 재설정 핀과 같다 — 해시로만 저장, 5회 틀리면 닫힘, 1분 간격, 24시간 10회(유효시간만 템플릿
 * 문구대로 15분). 다른 점:
 *
 * - 로그인한 본인만 부르므로 가입 여부를 숨길 일이 없다. 그래서 중복 이메일은 409, 간격 · 횟수 제한은 429 로 그대로 답하고,
 *   틀린 핀은 401 이 아니라 400 이다(401 이면 앱이 로그아웃으로 받는다).
 * - 저장을 커밋한 뒤 보내고, 보내지 못하면 그 핀을 지운다(재설정 링크와 같은 순서). 그래서 1분을 기다리지 않고 다시 받는다.
 * - 지금 비밀번호는 핀 요청에서만 받는다 — 핀은 비밀번호를 확인한 요청에서만 생기므로 확인 단계는 핀만 본다. 틀려도
 *   로그인 잠금 횟수는 세지 않고 요청 한도만 건다(비밀번호 변경과 같다, WHALEERP-607 · ACC-13).
 * - 바꿔도 접속은 끊지 않는다. 다음 로그인부터 새 이메일이고, 갱신은 이메일을 지금 행에서 읽어 새 토큰에 싣는다.
 */
@Injectable()
export class MyEmailChangeService {
  private readonly logger = new Logger(MyEmailChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: EmailChangePinSender,
  ) {
    // 운영에서 메일 설정이 없으면 기동은 하되 남긴다 — 직원이 첫 503 을 받기 전에 배포 로그에서 알게(재설정 링크와 같다).
    if (!sender.isAvailable() && isProduction())
      this.logger.error(
        'MAIL_* 가 없어 이메일 변경 핀을 보낼 수 없다 — 핀 요청이 모두 503 이다',
      );
  }

  async requestPin(
    accountId: number,
    rawNewEmail: string,
    currentPassword: string,
  ): Promise<void> {
    if (!this.sender.isAvailable())
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    const newEmail = rawNewEmail.trim().toLowerCase();
    const account = await this.liveAccount(this.prisma, accountId);
    // 비밀번호를 이메일 검사보다 먼저 본다 — 뒤에 보면 토큰만 가진 사람이 비밀번호 없이 다른 계정이 쓰는 주소인지 알아낸다.
    if (!(await verifyPassword(currentPassword, account.passwordHash)))
      throw new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE);
    if (account.email === newEmail)
      throw new BadRequestException('지금 쓰는 이메일과 같습니다.');
    await this.assertNotInUse(this.prisma, newEmail, accountId);

    const pin = generatePin();
    const pinHash = await hashPassword(pin);
    const issued = await this.prisma.$transaction(async (tx) => {
      // 같은 계정의 발급이 한 번에 하나씩 지나가게 — 동시에 눌린 요청이 모두 「직전 발급 없음」을 읽지 않게.
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      // 확인한 사이 재설정 · 비밀번호 변경이 먼저 끝났으면, 확인한 비밀번호는 이미 지금 비밀번호가 아니다.
      const locked = await this.liveAccount(tx, accountId);
      if (locked.passwordHash !== account.passwordHash)
        throw new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE);
      const now = new Date();
      const recent = await tx.emailChangePin.findFirst({
        where: { accountId },
        orderBy: { issuedAt: 'desc' },
        select: { issuedAt: true },
      });
      if (
        recent &&
        now.getTime() - recent.issuedAt.getTime() < REISSUE_INTERVAL_MS
      )
        throw new HttpException(
          '1분 뒤에 다시 받을 수 있습니다.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const count = await tx.emailChangePin.count({
        where: {
          accountId,
          issuedAt: { gte: new Date(now.getTime() - ISSUE_WINDOW_MS) },
        },
      });
      if (count >= MAX_ISSUES_PER_WINDOW) {
        this.logger.warn(
          `이메일 변경 핀 하루 발급 한도 도달 accountId=${accountId}`,
        );
        throw new HttpException(
          '오늘은 더 받을 수 없습니다. 내일 다시 시도해 주세요.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const { emailChangePinId } = await tx.emailChangePin.create({
        data: {
          accountId,
          newEmail,
          pinHash,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + PIN_LIFETIME_MS),
        },
        select: { emailChangePinId: true },
      });
      return { emailChangePinId, issuedAt: now };
    });

    // 커밋 뒤에 보낸다 — 메일을 트랜잭션 안에서 기다리면 SMTP 가 트랜잭션 기한(5초)을 넘길 때 메일은 나갔는데 핀은
    // 되돌려지고, 그동안 계정 행 잠금도 쥔다(재설정 링크와 같은 순서, api 리뷰 2026-10-20).
    try {
      await this.sender.send(newEmail, pin);
    } catch (error) {
      // 원인과 가린 주소는 MailService 가 남겼다. 여기서는 SMTP 원문 · 스택을 다시 찍지 않는다 — 받는 주소가 섞인다.
      const transient = isMailTransportError(error);
      this.logger.error(
        transient
          ? `이메일 변경 핀 발송 실패(SMTP) accountId=${accountId}`
          : `이메일 변경 핀을 보내기 전에 막힘(템플릿 · 설정 · DB) accountId=${accountId} ${errorKind(error)}`,
      );
      // 보내지 못한 핀은 지운다 — 남기면 다시 받을 때 1분 제한에 걸린다. 타임아웃이면 메일이 나갔을 수도 있지만 그
      // 핀은 쓸 수 없을 뿐이다(닫는 쪽으로 틀린다). 앞선 핀은 아직 닫지 않았으니 그대로 쓸 수 있다.
      try {
        await this.prisma.emailChangePin.deleteMany({
          where: { emailChangePinId: issued.emailChangePinId },
        });
      } catch (cleanupError) {
        this.logger.error(
          `보내지 못한 이메일 변경 핀을 지우지 못했다 emailChangePinId=${issued.emailChangePinId}`,
          cleanupError instanceof Error
            ? cleanupError.stack
            : String(cleanupError),
        );
      }
      // 템플릿이 꺼졌거나 DB 가 끊긴 것은 다시 해도 풀리지 않으니 「잠시 뒤에 다시」(503)가 아니라 500 이고, 할 일을
      // 알린다. 원래 오류는 던지지 않는다 — 그 메시지에 주소가 섞일 수 있고, 원인은 위 줄과 MailService 가 남겼다.
      if (!transient)
        throw new InternalServerErrorException(
          '메일 설정 문제로 인증 메일을 보내지 못했습니다. 관리자에게 문의해 주세요.',
        );
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    // 나간 뒤에 이번 핀보다 앞서 낸 열린 핀을 닫는다 — 다른 주소로 낸 핀도. 보내는 사이 새로 낸 핀은 발급 시각으로
    // 갈라 닫지 않는다. 실패해도 메일은 이미 나갔으므로 성공으로 답한다 — 확인은 가장 새 열린 핀만 보므로 남은 앞선
    // 핀은 쓰이지 않고, 다음 발급이 닫는다.
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
        await tx.emailChangePin.updateMany({
          where: { accountId, usedAt: null, issuedAt: { lt: issued.issuedAt } },
          data: { usedAt: new Date() },
        });
      });
    } catch (error) {
      this.logger.error(
        `이메일 변경 핀은 보냈으나 앞선 핀을 닫지 못했다 accountId=${accountId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * 핀을 확인하고 이메일을 바꾼다. 검증(scrypt)은 잠금 밖에서 하고, 잠금 안에서 핀을 다시 읽어 검증한 그 핀이 아직 쓸 수
   * 있을 때만 결과를 반영한다 — 재설정 핀(`PasswordResetService.checkPin`)과 같은 이유다. 틀린 횟수는 거부해도 남아야
   * 하므로 트랜잭션 안에서는 던지지 않고 결과만 돌려준다.
   */
  async confirm(accountId: number, rawPin: string): Promise<void> {
    const pin = normalizePin(rawPin);
    await this.liveAccount(this.prisma, accountId);
    const latestPin = (
      client: Pick<Prisma.TransactionClient, 'emailChangePin'>,
    ) =>
      client.emailChangePin.findFirst({
        where: { accountId, usedAt: null },
        orderBy: { issuedAt: 'desc' },
      });
    const candidate = await latestPin(this.prisma);
    if (!isUsable(candidate, new Date()))
      throw new BadRequestException(INVALID_EMAIL_CHANGE_PIN_MESSAGE);
    const matched = await verifyPassword(pin, candidate.pinHash);

    let outcome: Outcome;
    try {
      outcome = await this.prisma.$transaction(async (tx): Promise<Outcome> => {
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
        const now = new Date();
        const account = await this.liveAccount(tx, accountId);
        const row = await latestPin(tx);
        if (
          !isUsable(row, now) ||
          row.emailChangePinId !== candidate.emailChangePinId
        )
          return { kind: 'unusable' };
        if (!matched) {
          await tx.emailChangePin.update({
            where: { emailChangePinId: row.emailChangePinId },
            data: { attemptCount: { increment: 1 } },
          });
          return { kind: 'wrong' };
        }
        // 핀을 낸 뒤 다른 계정이 그 주소로 가입했거나 바꿨다. 핀은 그대로 둔다 — 쓸 수 없는 주소라 새로 받아야 한다.
        const taken = await tx.account.findUnique({
          where: { email: row.newEmail },
          select: { accountId: true },
        });
        if (taken && taken.accountId !== accountId) return { kind: 'in_use' };

        await tx.account.update({
          where: { accountId },
          data: { email: row.newEmail },
        });
        // 남은 열린 이메일 변경 핀도 닫는다 — 발급 뒤 앞선 핀 닫기가 실패했으면 다른 주소로 나간 핀이 남아, 한 번 더
        // 확인하면 이메일이 또 바뀐다.
        await tx.emailChangePin.updateMany({
          where: { accountId, usedAt: null },
          data: { usedAt: now },
        });
        // 옛 주소로 나간 비밀번호 재설정 핀 · 관리자 링크를 닫는다 — 남기면 옛 수신함을 가진 사람이 그것으로 비밀번호를
        // 바꿀 수 있다(api 리뷰 2026-10-20). 접속은 끊지 않는다.
        await tx.passwordResetPin.updateMany({
          where: { accountId, usedAt: null },
          data: { usedAt: now },
        });
        await tx.passwordResetLink.updateMany({
          where: { accountId, closedAt: null },
          data: { closedAt: now },
        });
        await tx.accountChangeHistory.create({
          data: {
            accountId,
            field: 'EMAIL',
            channel: 'SELF',
            beforeValue: account.email,
            afterValue: row.newEmail,
          },
        });
        return { kind: 'ok' };
      });
    } catch (error) {
      // 위 확인과 쓰기 사이에 다른 계정이 같은 주소를 가졌다 — 고유 제약이 막는다. 트랜잭션은 통째로 되돌아간다.
      if (isUniqueViolation(error))
        throw new ConflictException(EMAIL_IN_USE_MESSAGE);
      throw error;
    }

    switch (outcome.kind) {
      case 'ok':
        return;
      case 'in_use':
        throw new ConflictException(EMAIL_IN_USE_MESSAGE);
      case 'unusable':
      case 'wrong':
        throw new BadRequestException(INVALID_EMAIL_CHANGE_PIN_MESSAGE);
      default: {
        const unhandled: never = outcome;
        throw new Error(`처리하지 않은 결과: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private async liveAccount(
    client: Pick<Prisma.TransactionClient, 'account'>,
    accountId: number,
  ): Promise<{ email: string; passwordHash: string }> {
    const account = await client.account.findUniqueOrThrow({
      where: { accountId },
      select: { email: true, passwordHash: true, status: true },
    });
    if (account.status === 'WITHDRAWN')
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    return account;
  }

  private async assertNotInUse(
    client: Pick<Prisma.TransactionClient, 'account'>,
    email: string,
    accountId: number,
  ): Promise<void> {
    const taken = await client.account.findUnique({
      where: { email },
      select: { accountId: true },
    });
    if (taken && taken.accountId !== accountId)
      throw new ConflictException(EMAIL_IN_USE_MESSAGE);
  }
}
