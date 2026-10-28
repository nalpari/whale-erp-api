import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { LoginFailureReason, Prisma } from '@prisma/client';
import type { SignupTokenPayload } from '../admin-signup/admin-signup.service';
import {
  AdminSessionService,
  IssuedAdminSession,
} from '../admin-session/admin-session.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ATTEMPT_LOCK_MS,
  AttemptState,
  CLEARED_ATTEMPT_STATE,
  isLocked,
  registerFailure,
} from './attempt-lock';
import { JwtPayload } from './auth.types';
import { AdminLoginDto } from './dto/admin-login.dto';
import {
  AdminLoginResponseDto,
  AdminRefreshResponseDto,
} from './dto/admin-login.response.dto';
import { dummyPasswordHash, verifyPassword } from './password';

const ACCESS_TTL = '1h';

// 없는 아이디 · 비밀번호 불일치 · 임시 비밀번호 불일치 · 탈퇴 · 삭제를 같은 문구로 답한다(front auth.md, S-XJDKSI).
const INVALID_LOGIN_MESSAGE = '아이디 또는 비밀번호가 올바르지 않습니다.';
const INACTIVE_MESSAGE = '사용이 제한된 계정입니다. 관리자에게 문의해 주세요.';
// 풀리는 길은 5분 경과와 임시 비밀번호 발급 둘뿐이다(front auth.md).
const LOCKED_MESSAGE = `로그인이 잠겼습니다. ${ATTEMPT_LOCK_MS / 60_000}분 뒤에 다시 시도하거나 임시 비밀번호를 발급받아 주세요`;
// signupToken 이 만료·위조됐거나(10분 지남) 그 사이 계정이 탈퇴·삭제됐다 — front 는 이 문구를 보이지 않고
// 로그인 화면으로 보낸다(front 가입 완료 화면, 「웨일ERP 시작하기」).
const INVALID_SIGNUP_TOKEN_MESSAGE = '만료되었거나 올바르지 않은 요청입니다';

const ACCOUNT_SELECT = {
  adminAccountId: true,
  loginId: true,
  name: true,
  roleTypeCode: true,
  passwordHash: true,
  accountStatusCode: true,
  isDeleted: true,
  failedLoginCount: true,
  lockExpiresAt: true,
  isPasswordChangeRequired: true,
  updatedAt: true,
  bpCode: {
    select: { bpCodeId: true, bpCode: true, tradeName: true, isPlatform: true },
  },
} satisfies Prisma.AdminAccountSelect;
type FoundAccount = Prisma.AdminAccountGetPayload<{
  select: typeof ACCOUNT_SELECT;
}>;

type Verified =
  { kind: 'own' } | { kind: 'temporary'; temporaryPasswordId: number };

type SuccessOutcome =
  | {
      kind: 'issued';
      session: IssuedAdminSession;
      isPasswordChangeRequired: boolean;
    }
  | { kind: 'gone' }
  | { kind: 'inactive' }
  | { kind: 'locked' }
  | { kind: 'stale' };

/**
 * 관리자 웹(1팀 admin_accounts) 로그인. 판정 순서는 잠금 → 아이디 · 비밀번호 → 계정 상태 → 강제 변경이다
 * (front okf auth.md). 경합 처리는 직원 앱 로그인(AccountAuthService)과 같다 — 실패는 행을 잠그고 세고,
 * 성공은 행을 잠그고 다시 읽은 뒤에 세션을 만든다.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AdminSessionService,
    private readonly jwt: JwtService,
  ) {}

  async login(
    dto: AdminLoginDto,
    clientAddress: string | null,
  ): Promise<AdminLoginResponseDto> {
    const now = new Date();
    const found = await this.prisma.adminAccount.findUnique({
      where: { loginId: dto.loginId },
      select: ACCOUNT_SELECT,
    });
    // 탈퇴 · 삭제 계정은 없는 아이디와 같게 다룬다 — 같은 문구, 같은 검증 시간.
    const account =
      found && !found.isDeleted && found.accountStatusCode !== 'WITHDRAWN'
        ? found
        : null;
    const log = (
      failureReason?: LoginFailureReason,
      adminAccountId = found?.adminAccountId ?? null,
    ) => this.record(adminAccountId, clientAddress, failureReason);

    // 잠겨 있으면 비밀번호를 보지 않고 세지도 않는다. 세면 남의 잠금을 끝없이 미룰 수 있다.
    if (account && isLocked(this.stateOf(account), now)) {
      await log('LOCKED');
      throw this.locked();
    }

    // 계정 유무 · 임시 비밀번호 유무와 상관없이 scrypt 를 두 번 돈다. 횟수가 갈리면 시간만으로
    // 아이디가 있는지, 임시 비밀번호를 받았는지가 드러난다.
    const temporary = account
      ? await this.liveTemporary(account.adminAccountId, now)
      : null;
    const dummy = await dummyPasswordHash();
    const ownMatched = await verifyPassword(
      dto.password,
      account?.passwordHash ?? dummy,
    );
    const temporaryMatched = await verifyPassword(
      dto.password,
      temporary?.passwordHash ?? dummy,
    );

    if (!account) {
      await log(
        found?.accountStatusCode === 'WITHDRAWN'
          ? 'WITHDRAWN'
          : 'PASSWORD_MISMATCH',
      );
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }
    const verified: Verified | null = ownMatched
      ? { kind: 'own' }
      : temporaryMatched && temporary
        ? {
            kind: 'temporary',
            temporaryPasswordId: temporary.temporaryPasswordId,
          }
        : null;
    if (!verified) {
      const state = await this.countFailure(account.adminAccountId);
      await log('PASSWORD_MISMATCH');
      throw isLocked(state, new Date())
        ? this.locked()
        : new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }
    // 미사용은 비밀번호까지 맞을 때만 알린다(front auth.md).
    if (account.accountStatusCode !== 'ACTIVE') {
      await log('INACTIVE');
      throw new ForbiddenException(INACTIVE_MESSAGE);
    }

    const outcome = await this.completeSuccess(
      account,
      verified,
      dto,
      clientAddress,
    );
    if (outcome.kind === 'locked') {
      await log('LOCKED');
      throw this.locked();
    }
    if (outcome.kind === 'inactive') {
      await log('INACTIVE');
      throw new ForbiddenException(INACTIVE_MESSAGE);
    }
    // gone: 검증하는 사이 탈퇴 · 삭제. stale: 그 사이 비밀번호가 바뀌었거나 임시 비밀번호가 무효가 됐다.
    // 사용자는 맞는 값을 넣었으므로 세지 않는다.
    if (outcome.kind !== 'issued') {
      await log(outcome.kind === 'gone' ? 'WITHDRAWN' : 'PASSWORD_MISMATCH');
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    const { session } = outcome;
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      account: {
        adminAccountId: account.adminAccountId,
        loginId: account.loginId,
        name: account.name,
        roleTypeCode: account.roleTypeCode,
        bp: account.bpCode,
        isPasswordChangeRequired: outcome.isPasswordChangeRequired,
      },
    };
  }

  /**
   * 접근 토큰을 새로 낸다. 갱신 토큰은 회전하지 않고 만료만 마지막 사용부터 1시간으로 민다. 임시 비밀번호로
   * 들어와 아직 바꾸지 않은 계정은 그 임시 비밀번호의 만료를 넘겨 밀지 않는다(front auth.md 강제 변경 절).
   */
  async refresh(refreshToken: string): Promise<AdminRefreshResponseDto> {
    const { sessionId, adminAccountId } =
      await this.sessions.find(refreshToken);
    const account = await this.prisma.adminAccount.findUnique({
      where: { adminAccountId },
      select: { loginId: true, isPasswordChangeRequired: true },
    });
    if (!account)
      throw new UnauthorizedException('만료되었거나 종료된 접속입니다');
    let cap: Date | null = null;
    if (account.isPasswordChangeRequired) {
      const used = await this.prisma.temporaryPassword.findFirst({
        where: {
          adminAccountId,
          usedAt: { not: null },
          invalidatedAt: null,
          isDeleted: false,
          expiresAt: { gt: new Date() },
        },
        orderBy: { issuedAt: 'desc' },
        select: { expiresAt: true },
      });
      // 강제 변경 대상인데 로그인에 쓴 임시 비밀번호가 살아 있지 않다 — 다시 발급돼 끝났거나, 로그인 중에
      // 관리자가 초기화해 표시만 켜졌다. 이 세션으로는 바꿀 수도(401) 쓸 수도(403) 없으니 연장하지 않고 끝낸다.
      // 새로 받은 비밀번호로 다시 들어오면 된다.
      if (!used) {
        await this.sessions.revoke(sessionId);
        throw new UnauthorizedException('만료되었거나 종료된 접속입니다');
      }
      cap = used.expiresAt;
    }
    const accessToken = await this.signAccessToken(
      adminAccountId,
      account.loginId,
      sessionId,
    );
    const refreshTokenExpiresAt = await this.sessions.extend(
      sessionId,
      accessToken,
      cap,
    );
    return { accessToken, refreshTokenExpiresAt };
  }

  /** 로그아웃. 그 브라우저의 세션만 종료하고 다른 브라우저는 그대로 둔다. */
  async logout(sessionId: number): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  /**
   * 가입 완료 화면의 「웨일ERP 시작하기」. AdminSignupService.signup 이 가입 끝에 낸 10분짜리 signupToken
   * (typ: 'signup')을 비밀번호 없이 로그인 접속으로 바꾼다 — 방금 가입해 비밀번호를 다시 묻지 않는다
   * (signup.response.dto.ts 의 signupToken 설명, 2026-10-16). 토큰이 만료·위조됐거나 그 사이 계정이
   * 탈퇴·삭제됐으면 401, 미사용이면 403 — 둘 다 front 가 로그인 화면으로 보낸다.
   */
  async loginFromSignupToken(
    signupToken: string,
    deviceInformation: string | undefined,
    clientAddress: string | null,
  ): Promise<AdminLoginResponseDto> {
    let payload: SignupTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<SignupTokenPayload>(signupToken);
    } catch {
      throw new UnauthorizedException(INVALID_SIGNUP_TOKEN_MESSAGE);
    }
    if (payload.typ !== 'signup')
      throw new UnauthorizedException(INVALID_SIGNUP_TOKEN_MESSAGE);

    const account = await this.prisma.adminAccount.findUnique({
      where: { adminAccountId: payload.sub },
      select: ACCOUNT_SELECT,
    });
    if (
      !account ||
      account.isDeleted ||
      account.accountStatusCode === 'WITHDRAWN'
    )
      throw new UnauthorizedException(INVALID_SIGNUP_TOKEN_MESSAGE);
    if (account.accountStatusCode !== 'ACTIVE')
      throw new ForbiddenException(INACTIVE_MESSAGE);

    const session = await this.sessions.issue(
      { adminAccountId: account.adminAccountId, deviceInformation },
      (sessionId) =>
        this.signAccessToken(
          account.adminAccountId,
          account.loginId,
          sessionId,
        ),
    );
    await this.record(account.adminAccountId, clientAddress, undefined);

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      account: {
        adminAccountId: account.adminAccountId,
        loginId: account.loginId,
        name: account.name,
        roleTypeCode: account.roleTypeCode,
        bp: account.bpCode,
        isPasswordChangeRequired: account.isPasswordChangeRequired,
      },
    };
  }

  /**
   * 비밀번호가 맞은 뒤의 처리. 행을 잠그고 다시 읽어, 검증하던 사이에 잠금 · 상태 · 비밀번호 · 임시 비밀번호가
   * 바뀌지 않았을 때만 실패를 지우고 세션을 만들고 성공을 남긴다. 모두 한 트랜잭션이다.
   */
  private completeSuccess(
    account: FoundAccount,
    verified: Verified,
    dto: AdminLoginDto,
    clientAddress: string | null,
  ): Promise<SuccessOutcome> {
    const { adminAccountId } = account;
    return this.prisma.$transaction(async (tx): Promise<SuccessOutcome> => {
      await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${adminAccountId} FOR UPDATE`;
      const now = new Date();
      const current = await tx.adminAccount.findUniqueOrThrow({
        where: { adminAccountId },
        select: ACCOUNT_SELECT,
      });
      if (current.isDeleted || current.accountStatusCode === 'WITHDRAWN')
        return { kind: 'gone' };
      if (current.accountStatusCode !== 'ACTIVE') return { kind: 'inactive' };
      if (isLocked(this.stateOf(current), now)) return { kind: 'locked' };

      let expiresAtCap: Date | null = null;
      let isPasswordChangeRequired = current.isPasswordChangeRequired;
      if (verified.kind === 'temporary') {
        const temporary = await tx.temporaryPassword.findUnique({
          where: { temporaryPasswordId: verified.temporaryPasswordId },
        });
        if (
          !temporary ||
          temporary.invalidatedAt !== null ||
          temporary.isDeleted ||
          temporary.expiresAt <= now
        )
          return { kind: 'stale' };
        // 만료 전까지는 다시 들어올 수 있다. 사용 시각은 처음 쓴 때만 남긴다.
        if (temporary.usedAt === null)
          await tx.temporaryPassword.update({
            where: { temporaryPasswordId: temporary.temporaryPasswordId },
            data: { usedAt: now },
          });
        expiresAtCap = temporary.expiresAt;
        // 시스템이 만든 비밀번호로 들어왔으니 새 비밀번호를 정하게 한다(PL-QSBSYY).
        isPasswordChangeRequired = true;
      } else {
        if (current.passwordHash !== account.passwordHash)
          return { kind: 'stale' };
        // 기존 비밀번호로 먼저 들어오면 쓰지 않은 찾기용 임시 비밀번호는 무효가 된다(front auth.md 계정 찾기 절).
        // 다른 브라우저에서 임시 비밀번호로 들어와 켜진 강제 변경도 푼다 — 본인이 아는 비밀번호로 들어왔다.
        // 초기 · 초기화 비밀번호 계정은 비밀번호가 '!' 라 여기까지 오지 않는다.
        await tx.temporaryPassword.updateMany({
          where: {
            adminAccountId,
            purpose: 'TEMPORARY',
            usedAt: null,
            invalidatedAt: null,
          },
          data: { invalidatedAt: now },
        });
        isPasswordChangeRequired = false;
      }

      await tx.adminAccount.update({
        where: { adminAccountId },
        data: {
          lastLoginAt: now,
          // 로그인은 계정 수정이 아니다. 넘기지 않으면 @updatedAt 이 수정 일시와 동시 수정 잠금을 바꾼다.
          updatedAt: current.updatedAt,
          ...(current.failedLoginCount > 0 || current.lockExpiresAt !== null
            ? {
                failedLoginCount: CLEARED_ATTEMPT_STATE.failedCount,
                lockExpiresAt: CLEARED_ATTEMPT_STATE.lockExpiresAt,
              }
            : {}),
          ...(isPasswordChangeRequired !== current.isPasswordChangeRequired
            ? { isPasswordChangeRequired }
            : {}),
        },
      });
      const session = await this.sessions.issue(
        {
          adminAccountId,
          deviceInformation: dto.deviceInformation,
          expiresAtCap,
        },
        (sessionId) =>
          this.signAccessToken(adminAccountId, current.loginId, sessionId),
        tx,
      );
      await this.record(adminAccountId, clientAddress, undefined, tx);
      return { kind: 'issued', session, isPasswordChangeRequired };
    });
  }

  /** 틀린 시도를 한 번 센다. 행을 잠그고 읽고 쓰는 것까지 한 트랜잭션이다 — 병렬 시도가 5회 제한을 넘지 못하게. */
  private countFailure(adminAccountId: number): Promise<AttemptState> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${adminAccountId} FOR UPDATE`;
      const now = new Date();
      const stored = await tx.adminAccount.findUniqueOrThrow({
        where: { adminAccountId },
        select: {
          failedLoginCount: true,
          lockExpiresAt: true,
          updatedAt: true,
        },
      });
      const current = this.stateOf(stored);
      const next = registerFailure(current, now);
      if (next !== current)
        await tx.adminAccount.update({
          where: { adminAccountId },
          data: {
            failedLoginCount: next.failedCount,
            lockExpiresAt: next.lockExpiresAt,
            updatedAt: stored.updatedAt, // 실패 횟수는 계정 수정이 아니다
          },
        });
      return next;
    });
  }

  /** 만료 전 · 무효화 전인 가장 최근 임시 비밀번호. 다시 발급하면 앞의 것은 무효가 되므로 하나다. */
  private liveTemporary(adminAccountId: number, now: Date) {
    return this.prisma.temporaryPassword.findFirst({
      where: {
        adminAccountId,
        invalidatedAt: null,
        isDeleted: false,
        expiresAt: { gt: now },
      },
      orderBy: { issuedAt: 'desc' },
      select: { temporaryPasswordId: true, passwordHash: true },
    });
  }

  private signAccessToken(
    adminAccountId: number,
    loginId: string,
    sessionId: number,
  ): Promise<string> {
    const claims: JwtPayload & { jti: string } = {
      sub: adminAccountId,
      type: 'admin',
      loginId,
      typ: 'access',
      sid: sessionId,
      // 같은 초에 두 번 발급해도 토큰이 달라지게.
      jti: randomUUID(),
    };
    return this.jwt.signAsync(claims, { expiresIn: ACCESS_TTL });
  }

  private async record(
    adminAccountId: number | null,
    clientAddress: string | null,
    failureReason?: LoginFailureReason,
    client: Pick<Prisma.TransactionClient, 'adminLoginLog'> = this.prisma,
  ): Promise<void> {
    await client.adminLoginLog.create({
      data: {
        adminAccountId,
        clientAddress,
        isSucceeded: failureReason === undefined,
        ...(failureReason === undefined ? {} : { failureReason }),
      },
    });
  }

  private stateOf(account: {
    failedLoginCount: number;
    lockExpiresAt: Date | null;
  }): AttemptState {
    return {
      failedCount: account.failedLoginCount,
      lockExpiresAt: account.lockExpiresAt,
    };
  }

  private locked(): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: LOCKED_MESSAGE,
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
