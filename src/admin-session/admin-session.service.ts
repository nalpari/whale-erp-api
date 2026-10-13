import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hashToken } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';

/** 관리자 웹 갱신 토큰 수명 — 마지막 사용부터 1시간(front okf auth.md, S-QCNVFC). */
export const ADMIN_SESSION_LIFETIME_MS = 60 * 60 * 1000;

/** 갱신 실패의 공통 메시지. 원인별로 다르게 답하지 않는다. */
export const INVALID_ADMIN_SESSION_MESSAGE = '만료되었거나 종료된 접속입니다';

type SessionClient = Pick<Prisma.TransactionClient, 'adminSession'>;

export interface IssueAdminSessionInput {
  adminAccountId: number;
  /** 기기를 구분하는 값. 같은 기기로 다시 로그인하면 그 기기의 이전 세션만 종료한다. */
  deviceInformation?: string;
  /** 이보다 늦게 끝나지 않는다. 임시 비밀번호로 들어온 세션은 그 임시 비밀번호의 만료에서 끝난다. */
  expiresAtCap?: Date | null;
}

export interface IssuedAdminSession {
  sessionId: number;
  accessToken: string;
  /** 원문은 이 응답에만 있다. DB 에는 해시만 남는다. */
  refreshToken: string;
  expiresAt: Date;
}

/**
 * 관리자 웹(1팀 admin_sessions) 접속 상태. 3팀 AuthSessionService 와 규칙은 같고 테이블 · 수명 · 칸이 달라
 * 따로 둔다 — 갱신 토큰 해시에 인덱스가 없으므로 토큰 앞에 세션 id 를 붙여 기본키로 찾는다.
 */
@Injectable()
export class AdminSessionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 새 세션을 만든다. 접근 토큰에 세션 id 가 들어가야 해서 행을 먼저 만들고, 그 id 로 서명한 뒤 두 해시를
   * 채운다. 로그인 성공 처리와 한 트랜잭션이어야 하면 그 클라이언트를 넘긴다.
   */
  issue(
    input: IssueAdminSessionInput,
    signAccessToken: (sessionId: number) => Promise<string>,
    client?: SessionClient,
  ): Promise<IssuedAdminSession> {
    if (client) return this.issueWith(client, input, signAccessToken);
    return this.prisma.$transaction((tx) =>
      this.issueWith(tx, input, signAccessToken),
    );
  }

  private async issueWith(
    client: SessionClient,
    input: IssueAdminSessionInput,
    signAccessToken: (sessionId: number) => Promise<string>,
  ): Promise<IssuedAdminSession> {
    const now = new Date();
    const deviceInformation = input.deviceInformation ?? null;
    // 같은 기기로 다시 로그인하면 그 기기의 이전 세션만 끊는다. 여러 브라우저 동시 로그인(S-XJDKSI).
    if (deviceInformation !== null)
      await client.adminSession.updateMany({
        where: {
          adminAccountId: input.adminAccountId,
          deviceInformation,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });

    const expiresAt = this.expiry(now, input.expiresAtCap);
    // 해시 칸은 NOT NULL 인데 토큰은 id 를 받은 뒤에야 만들 수 있다. 같은 트랜잭션에서 바로 채운다.
    const { sessionId } = await client.adminSession.create({
      data: {
        adminAccountId: input.adminAccountId,
        deviceInformation,
        accessTokenHash: '',
        refreshTokenHash: '',
        refreshLastUsedAt: now,
        expiresAt,
      },
    });
    const accessToken = await signAccessToken(sessionId);
    const refreshToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
    await client.adminSession.update({
      where: { sessionId },
      data: {
        accessTokenHash: hashToken(accessToken),
        refreshTokenHash: hashToken(refreshToken),
      },
    });
    return { sessionId, accessToken, refreshToken, expiresAt };
  }

  /**
   * 갱신 토큰이 가리키는 살아 있는 세션. 없는 토큰 · 종료 · 삭제 · 만료 · 계정 미사용/삭제/탈퇴를 같은
   * 401 로 거부한다(front auth.md — 갱신 때 계정 상태를 본다). 쓰지 않는다 — 미는 것은 `extend`.
   */
  async find(
    refreshToken: string,
  ): Promise<{ sessionId: number; adminAccountId: number }> {
    const sessionId = Number(refreshToken.split('.')[0]);
    if (!Number.isInteger(sessionId) || sessionId < 1 || sessionId > 2147483647)
      throw new UnauthorizedException(INVALID_ADMIN_SESSION_MESSAGE);
    const session = await this.prisma.adminSession.findUnique({
      where: { sessionId },
      include: {
        adminAccount: { select: { accountStatusCode: true, isDeleted: true } },
      },
    });
    if (
      !session ||
      !sameHash(session.refreshTokenHash, hashToken(refreshToken)) ||
      session.revokedAt !== null ||
      session.isDeleted ||
      session.expiresAt.getTime() <= Date.now() ||
      session.adminAccount.accountStatusCode !== 'ACTIVE' ||
      session.adminAccount.isDeleted
    )
      throw new UnauthorizedException(INVALID_ADMIN_SESSION_MESSAGE);
    return { sessionId, adminAccountId: session.adminAccountId };
  }

  /**
   * 마지막 사용 시각을 지금으로 하고 만료를 1시간 뒤(상한이 있으면 상한)로 민다. 읽은 뒤 쓰는 사이에
   * 종료 · 만료될 수 있어 살아 있는 조건을 갱신에 다시 건다. 새 만료 시각을 돌려준다.
   */
  async extend(
    sessionId: number,
    accessToken: string,
    expiresAtCap?: Date | null,
  ): Promise<Date> {
    const now = new Date();
    const expiresAt = this.expiry(now, expiresAtCap);
    if (expiresAt.getTime() <= now.getTime())
      throw new UnauthorizedException(INVALID_ADMIN_SESSION_MESSAGE);
    const { count } = await this.prisma.adminSession.updateMany({
      where: {
        sessionId,
        revokedAt: null,
        isDeleted: false,
        expiresAt: { gt: now },
        adminAccount: { accountStatusCode: 'ACTIVE', isDeleted: false },
      },
      data: {
        refreshLastUsedAt: now,
        expiresAt,
        accessTokenHash: hashToken(accessToken),
      },
    });
    if (count === 0)
      throw new UnauthorizedException(INVALID_ADMIN_SESSION_MESSAGE);
    return expiresAt;
  }

  /**
   * 접근 토큰이 가리키는 세션이 살아 있는지. 요청마다 가드가 부른다. 계정 상태는 보지 않는다 — 미사용 ·
   * 삭제 · 탈퇴로 로그인 중인 세션을 바로 끊지 않고 갱신에서 막는다(front auth.md, 최대 1시간).
   */
  async isActive(sessionId: number, adminAccountId: number): Promise<boolean> {
    const alive = await this.prisma.adminSession.count({
      where: {
        sessionId,
        adminAccountId,
        revokedAt: null,
        isDeleted: false,
        expiresAt: { gt: new Date() },
      },
    });
    return alive > 0;
  }

  /** 세션 하나를 종료한다(로그아웃). 이미 종료됐거나 없어도 던지지 않는다. */
  async revoke(sessionId: number): Promise<void> {
    // undefined 면 Prisma 가 조건을 빼 모든 세션이 종료된다.
    if (!Number.isInteger(sessionId))
      throw new Error(`세션 ID 가 정수가 아니다: ${String(sessionId)}`);
    await this.prisma.adminSession.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private expiry(now: Date, cap?: Date | null): Date {
    const full = new Date(now.getTime() + ADMIN_SESSION_LIFETIME_MS);
    return cap && cap < full ? cap : full;
  }
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
