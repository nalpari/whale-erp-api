import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccountStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { isProduction } from '../config/profile';
import { errorKind } from '../mail/error-kind';
import { isMailTransportError } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { applyNewPassword } from './apply-new-password';
import { hashPassword, hashToken } from './password';
import { validateNewPassword } from './password-policy';
import { PasswordResetLinkSender } from './password-reset-link-sender';
import { readStaffAppUrl, resetLinkOf } from './staff-app-url';

/** 링크 수명. 24시간 동안 한 번만 쓴다(WHALEERP-172). */
export const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** 같은 계정에 다시 보낼 수 있는 간격. 하루 제한은 없다. */
export const REISSUE_INTERVAL_MS = 60 * 1000;

/** 링크 주소 · 메일 설정이 없다. 기다려도 풀리지 않는다. */
const UNAVAILABLE_MESSAGE =
  '메일 발송이 설정되지 않아 재설정 링크를 보낼 수 없습니다. 운영자에게 문의해 주세요';
/** 발송 실패. 앞선 링크 · 핀은 닫지 않았으니 그대로 쓸 수 있다. */
const SEND_FAILED_MESSAGE =
  '재설정 링크를 보내지 못했습니다. 잠시 뒤에 다시 보내 주세요';
const RETIRED_MESSAGE = '퇴직한 직원에게는 재설정 링크를 보낼 수 없습니다';
const WITHDRAWN_MESSAGE = '탈퇴한 계정입니다';
const INTERVAL_MESSAGE =
  '방금 재설정 링크를 보냈습니다. 1분 뒤에 다시 보낼 수 있습니다';

/** 만료 · 사용 · 대체 · 없는 토큰 · 탈퇴를 가리지 않는다(WHALEERP-172). */
export const INVALID_LINK_MESSAGE =
  '쓸 수 없는 링크입니다. 관리자에게 다시 청하거나 비밀번호 찾기로 인증번호를 받아 다시 정해 주세요';

interface LinkState {
  closedAt: Date | null;
  expiresAt: Date;
  account: { status: AccountStatus };
}

/** 쓸 수 있는 링크인지. 만료 시각과 같은 순간도 만료다. */
function isUsableLink(link: LinkState | null, now: Date): link is LinkState {
  return (
    link !== null &&
    link.closedAt === null &&
    link.expiresAt.getTime() > now.getTime() &&
    link.account.status !== 'WITHDRAWN'
  );
}

const LINK_SELECT = {
  passwordResetLinkId: true,
  accountId: true,
  requestedBy: true,
  closedAt: true,
  expiresAt: true,
  account: { select: { email: true, status: true } },
} as const;

/** 규칙을 통과한 새 비밀번호의 해시, 또는 어긋난 사유. 둘 중 하나만 있다. */
type PasswordCandidate =
  | { kind: 'valid'; passwordHash: string }
  | { kind: 'rejected'; reason: string };

export interface IssuedLink {
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * 관리자 초기화 재설정 링크(WHALEERP-172). 관리자가 보내고(issue), 직원이 링크로 확인하고(verify) 새 비밀번호를
 * 정한다(reset). 관리자는 비밀번호를 알 수도 정할 수도 없다 — 링크는 직원 메일함으로만 간다.
 *
 * 링크를 새로 보내면 — 메일이 나간 뒤에 — 앞선 링크와 핀을 닫는다. 본인 핀 요청은 링크를 닫지 않는다 — 핀 요청은 이메일만 알면 누구나
 * 보낼 수 있어, 닫으면 남이 관리자 조치를 무력화할 수 있다.
 */
@Injectable()
export class PasswordResetLinkService {
  private readonly logger = new Logger(PasswordResetLinkService.name);
  private readonly appUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PasswordResetLinkSender,
    private readonly sessions: AuthSessionService,
    config: ConfigService,
  ) {
    // 잘못된 값은 여기서 던져 기동을 멈춘다. 비었으면 null — 발송만 503 이다.
    const production = isProduction();
    this.appUrl = readStaffAppUrl(
      config.get<string>('STAFF_APP_URL'),
      production,
    );
    // 운영에서 비어 있으면 기동은 하되 남긴다 — 관리자가 첫 503 을 받기 전에 배포 로그에서 알게.
    if (this.appUrl === null && production)
      this.logger.error(
        'STAFF_APP_URL 이 비어 있어 관리자 초기화 재설정 링크를 보낼 수 없다',
      );
    if (!sender.isAvailable() && production)
      this.logger.error(
        'MAIL_* 가 없어 재설정 링크 발송기를 쓸 수 없다 — 관리자 초기화가 모두 503 이다',
      );
  }

  /**
   * 링크를 보낸다. 관리 범위는 부르는 쪽(컨트롤러)이 확인했다. 관리자 경로라 응답이 직원 상태로 갈려도 드러날 것이
   * 없어, 사유를 메시지로 가른다.
   */
  async issue(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<IssuedLink> {
    const staff = await this.prisma.staffMember.findUnique({
      where: { staffMemberId },
      select: { accountId: true, storeId: true, employmentStatus: true },
    });
    // 범위를 확인한 뒤 사이에 지워졌다. 없는 직원과 같게 답한다.
    if (!staff) throw new NotFoundException('직원을 찾을 수 없습니다');
    if (staff.accountId === null)
      throw new ConflictException(
        '가입을 마치지 않은 직원입니다. 재설정 링크 대신 초대를 다시 보내 주세요',
      );
    if (staff.employmentStatus === 'RETIRED')
      throw new ConflictException(RETIRED_MESSAGE);
    const account = await this.prisma.account.findUnique({
      where: { accountId: staff.accountId },
      select: { accountId: true, email: true, realName: true, status: true },
    });
    if (!account || account.status === 'WITHDRAWN')
      throw new ConflictException(WITHDRAWN_MESSAGE);
    if (this.appUrl === null || !this.sender.isAvailable())
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    const store = await this.prisma.store.findUnique({
      where: { storeId: staff.storeId },
      select: { name: true },
    });

    const token = randomBytes(32).toString('base64url');
    const issued = await this.prisma.$transaction(async (tx) => {
      // 계정 행을 잠가 같은 계정의 발급이 한 번에 하나씩 지나가게 한다. 잠그지 않으면 동시에 눌린 요청이 모두
      // 「직전 발급 없음」을 읽고 1분 제한을 넘는다.
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${account.accountId} FOR UPDATE`;
      // 시각은 잠금을 잡은 뒤에 잡는다 — 기다리는 사이 끝난 발급을 1분 제한에서 놓치지 않고, 기한이 실제 발급
      // 시각에서 세어지게.
      const now = new Date();
      // 잠그기 전에 본 상태를 다시 본다 — 그 사이 탈퇴하거나 퇴직 처리됐으면 보내지 않는다(핀의 checkPin 과 같다).
      const { status } = await tx.account.findUniqueOrThrow({
        where: { accountId: account.accountId },
        select: { status: true },
      });
      if (status === 'WITHDRAWN') return { kind: 'withdrawn' as const };
      const { employmentStatus } = await tx.staffMember.findUniqueOrThrow({
        where: { staffMemberId },
        select: { employmentStatus: true },
      });
      if (employmentStatus === 'RETIRED') return { kind: 'retired' as const };
      const recent = await tx.passwordResetLink.findFirst({
        where: { accountId: account.accountId },
        orderBy: { issuedAt: 'desc' },
        select: { issuedAt: true },
      });
      if (
        recent &&
        now.getTime() - recent.issuedAt.getTime() < REISSUE_INTERVAL_MS
      )
        return { kind: 'interval' as const };
      // 앞선 링크 · 핀은 여기서 닫지 않는다 — 메일이 나간 뒤에 닫는다(아래).
      const expiresAt = new Date(now.getTime() + LINK_LIFETIME_MS);
      const { passwordResetLinkId } = await tx.passwordResetLink.create({
        data: {
          accountId: account.accountId,
          tokenHash: hashToken(token),
          issuedAt: now,
          expiresAt,
          requestedBy: adminAccountId,
        },
        select: { passwordResetLinkId: true },
      });
      return {
        kind: 'issued' as const,
        passwordResetLinkId,
        issuedAt: now,
        expiresAt,
      };
    });
    if (issued.kind === 'withdrawn')
      throw new ConflictException(WITHDRAWN_MESSAGE);
    if (issued.kind === 'retired') throw new ConflictException(RETIRED_MESSAGE);
    if (issued.kind === 'interval')
      throw new HttpException(INTERVAL_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);

    // 커밋 뒤에 보낸다 — 먼저 보내면 롤백돼도 메일은 이미 나가 있다. 관리자 경로라 핀과 달리 기다린다 — 실패를
    // 관리자에게 알려야 한다.
    try {
      await this.sender.send(
        {
          accountId: account.accountId,
          email: account.email,
          realName: account.realName,
        },
        {
          storeName: store?.name ?? '',
          link: resetLinkOf(this.appUrl, token),
          expiresAt: issued.expiresAt,
          requestedBy: adminAccountId,
        },
      );
    } catch (error) {
      // 원인부터 남긴다 — 아래 지우기까지 실패해도 원인이 묻히지 않게. 토큰 · 링크는 로그에 남기지 않는다(발송기는 오류에
      // 링크를 싣지 않는다 — PasswordResetLinkSender 계약). SMTP 원문 · 스택도 다시 찍지 않는다 — 받는 주소가 섞이고, 가린
      // 원인은 MailService 가 이미 남겼다(api 리뷰 2026-10-20).
      const transient = isMailTransportError(error);
      this.logger.error(
        transient
          ? `재설정 링크 발송 실패(SMTP) accountId=${account.accountId}`
          : `재설정 링크를 보내기 전에 막힘(템플릿 · 설정 · DB) accountId=${account.accountId} ${errorKind(error)}`,
      );
      // 보내지 못한 링크는 지운다 — 남겨 두면 관리자가 바로 다시 보낼 때 1분 제한에 걸린다. 타임아웃이면 메일이
      // 나갔을 수도 있지만, 그때 직원은 「쓸 수 없는 링크」를 볼 뿐이다(닫는 쪽으로 틀린다). 앞선 링크 · 핀은 아직
      // 닫지 않았으니 그대로 쓸 수 있다. 지우기가 실패하면 링크가 남지만, 1분 뒤에는 다시 보낼 수 있고 새 발급이
      // 이 링크를 닫는다.
      try {
        await this.prisma.passwordResetLink.deleteMany({
          where: { passwordResetLinkId: issued.passwordResetLinkId },
        });
      } catch (cleanupError) {
        this.logger.error(
          `보내지 못한 재설정 링크를 지우지 못했다 passwordResetLinkId=${issued.passwordResetLinkId}`,
          cleanupError instanceof Error
            ? cleanupError.stack
            : String(cleanupError),
        );
      }
      // 템플릿이 꺼졌거나 DB 가 끊긴 것은 다시 보내도 풀리지 않으니 「잠시 뒤에 다시」(503)가 아니라 500 이고, 할 일을
      // 알린다. 원래 오류는 던지지 않는다 — 그 메시지에 주소가 섞일 수 있고, 원인은 위 줄과 MailService 가 남겼다.
      if (!transient)
        throw new InternalServerErrorException(
          '메일 설정 문제로 재설정 링크를 보내지 못했습니다. 플랫폼 관리자에게 문의해 주세요',
        );
      throw new ServiceUnavailableException(SEND_FAILED_MESSAGE);
    }

    // 나간 뒤에 이번 발급보다 앞선 링크와 열린 핀을 닫는다. 보내는 사이 직원이 새로 받은 핀이나 그 사이 다른
    // 관리자가 보낸 더 새 링크는 닫지 않는다(발급 시각으로 가른다). 닫힌 시각은 잠금 뒤 실제 시각이다.
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${account.accountId} FOR UPDATE`;
        const closedAt = new Date();
        const before = { lt: issued.issuedAt };
        await tx.passwordResetLink.updateMany({
          where: {
            accountId: account.accountId,
            closedAt: null,
            issuedAt: before,
          },
          data: { closedAt },
        });
        await tx.passwordResetPin.updateMany({
          where: {
            accountId: account.accountId,
            usedAt: null,
            issuedAt: before,
          },
          data: { usedAt: closedAt },
        });
      });
    } catch (error) {
      // 메일은 이미 나갔다 — 관리자에게 실패로 답하면 다시 눌러 1분 제한에 걸리거나, 받은 링크를 두고 헷갈린다.
      // 남은 앞선 링크 · 핀은 다음 발급이나 직원이 새 비밀번호를 정할 때(applyNewPassword) 닫힌다.
      this.logger.error(
        `재설정 링크는 보냈으나 앞선 링크 · 핀을 닫지 못했다 accountId=${account.accountId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
    return { issuedAt: issued.issuedAt, expiresAt: issued.expiresAt };
  }

  /** 링크가 쓸 수 있는지만 본다. 소진하지 않는다 — 메일 보안 스캐너가 미리 열어도 닫히지 않게. */
  async verify(token: string): Promise<void> {
    const link = await this.prisma.passwordResetLink.findUnique({
      where: { tokenHash: hashToken(token) },
      select: LINK_SELECT,
    });
    if (!isUsableLink(link, new Date()))
      throw new UnauthorizedException(INVALID_LINK_MESSAGE);
  }

  /**
   * 링크로 새 비밀번호를 정한다. 규칙 검사와 (통과했을 때만) 해시는 잠금 밖에서 하고, 계정 행을 잠근 뒤 링크를 다시 읽어 아직 쓸 수
   * 있을 때만 반영한다 — 같은 링크로 동시에 두 번 정하지 못하게. 규칙 위반 사유는 잠금 안에서 링크가 쓸 수 있다고
   * 확인한 뒤에만 준다. 거절(400 · 401)은 트랜잭션 밖에서 던진다.
   */
  async reset(token: string, newPassword: string): Promise<void> {
    const found = await this.prisma.passwordResetLink.findUnique({
      where: { tokenHash: hashToken(token) },
      select: LINK_SELECT,
    });
    if (!isUsableLink(found, new Date()))
      throw new UnauthorizedException(INVALID_LINK_MESSAGE);
    const reason = validateNewPassword(newPassword, found.account.email);
    const candidate: PasswordCandidate =
      reason === null
        ? { kind: 'valid', passwordHash: await hashPassword(newPassword) }
        : { kind: 'rejected', reason };

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<'ok' | 'unusable' | 'rejected'> => {
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${found.accountId} FOR UPDATE`;
        const now = new Date();
        const row = await tx.passwordResetLink.findUnique({
          where: { passwordResetLinkId: found.passwordResetLinkId },
          select: LINK_SELECT,
        });
        if (!isUsableLink(row, now)) return 'unusable';
        if (candidate.kind === 'rejected') return 'rejected';
        await applyNewPassword(tx, this.sessions, {
          accountId: row.accountId,
          passwordHash: candidate.passwordHash,
          now,
          channel: 'ADMIN_RESET',
          requestedBy: row.requestedBy,
        });
        return 'ok';
      },
    );
    if (outcome === 'unusable')
      throw new UnauthorizedException(INVALID_LINK_MESSAGE);
    if (candidate.kind === 'rejected')
      throw new BadRequestException(candidate.reason);
  }
}
