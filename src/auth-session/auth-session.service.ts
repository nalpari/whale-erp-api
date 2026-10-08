import { randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AccountLoginFailureReason, Prisma } from '@prisma/client';
import { hashToken } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';

/** 마지막 사용으로부터 접속 상태를 유지하는 기간. 지나면 다시 로그인한다. */
export const SESSION_LIFETIME_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const INVALID_SESSION_MESSAGE = '만료되었거나 종료된 접속입니다';

export interface IssueAuthSessionInput {
  accountId: number;
  /** 기기를 구분하는 값. 없으면 기기 단위로 접속 상태를 정리할 수 없다. */
  deviceIdentifier?: string;
}

export interface IssuedAuthSession {
  authSessionId: number;
  /** 원문은 이 응답에만 있다. DB 에는 해시만 남는다. */
  refreshToken: string;
  expiresAt: Date;
}

export interface ValidAuthSession {
  authSessionId: number;
  accountId: number;
  deviceIdentifier: string | null;
  expiresAt: Date;
}

export interface LoginAttemptInput {
  /** 없는 이메일로 시도했으면 비운다. */
  accountId?: number;
  email: string;
  isSucceeded: boolean;
  failureReason?: AccountLoginFailureReason;
}

@Injectable()
export class AuthSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(input: IssueAuthSessionInput): Promise<IssuedAuthSession> {
    const now = new Date();
    const deviceIdentifier = input.deviceIdentifier ?? null;

    // 한 기기 한 행. 같은 기기로 다시 로그인하면 그 기기의 이전 접속 상태만
    // 종료한다. 계정 전체를 종료하면 한 기기에서 로그인할 때 다른 기기가
    // 로그아웃되어 여러 기기를 쓸 수 없다. 기기를 구분할 수 없으면 어느 것이
    // 같은 기기인지 알 수 없으므로 종료하지 않는다.
    if (deviceIdentifier !== null) {
      await this.prisma.authSession.updateMany({
        where: {
          accountId: input.accountId,
          deviceIdentifier,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
    }

    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_DAYS * DAY_MS);
    const { authSessionId } = await this.prisma.authSession.create({
      data: {
        accountId: input.accountId,
        deviceIdentifier,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt,
      },
    });

    return { authSessionId, refreshToken, expiresAt };
  }

  /**
   * 받은 갱신 토큰이 살아 있는 접속 상태를 가리키는지 확인하고, 살아 있으면
   * 마지막 사용 시각을 지금으로 갱신해 만료를 지금부터 30일 뒤로 민다.
   * 클라이언트는 401 을 받으면 로그인 화면으로 보낸다.
   *
   * 없는 토큰·만료·종료를 같은 메시지로 답한다. 구분해 주면 토큰이 한때
   * 유효했는지를 밖에서 알아낼 수 있다.
   */
  async validate(refreshToken: string): Promise<ValidAuthSession> {
    const now = new Date();
    const session = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });
    // 만료 시각과 같은 순간도 만료다. 경계를 유효로 두면 만료 시각이
    // 사실상 하루의 끝까지 늘어나는 오해가 생긴다.
    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    )
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);

    // 읽은 뒤 쓰는 사이에 로그아웃되거나 만료될 수 있으므로, 살아 있다는
    // 조건을 갱신에 다시 건다. 조건이 안 맞으면 종료된 접속 상태를 되살리지
    // 않고 거부한다.
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_DAYS * DAY_MS);
    const { count } = await this.prisma.authSession.updateMany({
      where: {
        authSessionId: session.authSessionId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { lastUsedAt: now, expiresAt },
    });
    if (count === 0) throw new UnauthorizedException(INVALID_SESSION_MESSAGE);

    return {
      authSessionId: session.authSessionId,
      accountId: session.accountId,
      deviceIdentifier: session.deviceIdentifier,
      expiresAt,
    };
  }

  /**
   * 액세스 토큰이 가리키는 접속 상태가 지금 살아 있는지. 요청마다 가드가 부른다.
   * 읽기만 한다 — 마지막 사용 시각과 만료는 갱신(`validate`)에서만 민다. 요청마다
   * 쓰면 모든 API 호출이 쓰기가 되고, 15분짜리 액세스 토큰 단위로도 "마지막
   * 사용" 기준은 충분하다.
   *
   * 접속 ID 만이 아니라 계정도 조건에 건다. 토큰의 주체와 접속 상태의 주인이
   * 다르면 다른 사람의 접속 상태로 통과하는 일이 없어야 한다.
   */
  async isActive(authSessionId: number, accountId: number): Promise<boolean> {
    const alive = await this.prisma.authSession.count({
      where: {
        authSessionId,
        accountId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    return alive > 0;
  }

  /**
   * 접속 상태 하나를 종료한다. 로그아웃이 부른다 — 그 기기의 접속만 끊고 다른
   * 기기는 그대로 둔다. 이미 종료됐거나 없어도 던지지 않는다. 로그아웃은 다시
   * 불러도 같은 결과여야 하고, 같은 요청이 겹쳐 와도 하나가 500 이 되면 안 된다.
   */
  async revoke(authSessionId: number): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { authSessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * 그 계정의 살아 있는 접속 상태를 기기와 상관없이 모두 종료한다. 비밀번호가
   * 새로 정해졌을 때 쓴다. 다른 기기가 옛 비밀번호로 얻은 접속을 계속 들고
   * 있으면 재설정이 의미가 없다. 종료한 수를 돌려준다.
   */
  async revokeAll(
    accountId: number,
    // 비밀번호 변경처럼 다른 쓰기와 한 트랜잭션이어야 할 때 그 트랜잭션의 클라이언트를 넘긴다.
    // 따로 쓰면 비밀번호만 바뀌고 접속은 남는 순간이 생긴다.
    client: Pick<Prisma.TransactionClient, 'authSession'> = this.prisma,
  ): Promise<number> {
    const { count } = await client.authSession.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async recordLoginAttempt(input: LoginAttemptInput): Promise<void> {
    await this.prisma.loginHistory.create({
      data: {
        accountId: input.accountId ?? null,
        email: input.email,
        isSucceeded: input.isSucceeded,
        failureReason: input.failureReason ?? null,
      },
    });
  }
}
