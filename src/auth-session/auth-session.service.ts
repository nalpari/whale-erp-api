import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AccountLoginFailureReason } from '@prisma/client';
import { hashToken } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';

/** 마지막 접속으로부터 접속 상태를 유지하는 기간. 지나면 다시 로그인한다. */
export const SESSION_LIFETIME_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

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
