import { randomBytes, randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccountLoginFailureReason } from '@prisma/client';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ATTEMPT_LOCK_MS,
  AttemptState,
  isLocked,
  registerFailure,
} from './attempt-lock';
import { JwtPayload } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login.response.dto';
import { RefreshResponseDto } from './dto/refresh.response.dto';
import { hashPassword, verifyPassword } from './password';

const ACCESS_TTL = '15m';

// 아이디와 비밀번호 가운데 어느 쪽이 틀렸는지 구분해 알리지 않는다.
const INVALID_LOGIN_MESSAGE = '이메일 또는 비밀번호가 올바르지 않습니다';

// 갱신 대상 계정이 사라진 경우. 접속 상태 서비스의 거부와 같은 말로 답한다.
const INVALID_SESSION_MESSAGE = '만료되었거나 종료된 접속입니다';

// 잠겨 있을 때만 다른 답을 준다. 그 계정이 있고 틀린 시도가 5번 쌓였다는 뜻이라
// 가입 여부가 그 순간에는 드러난다. 잠금을 알리지 않으면 정상 사용자가 왜 안
// 되는지, 비밀번호 재설정으로 풀 수 있다는 것을 알 길이 없어서 안내한다.
const LOCKED_MESSAGE = `로그인이 잠겼습니다. ${ATTEMPT_LOCK_MS / 60_000}분 뒤에 다시 시도하거나 비밀번호를 재설정해 주세요`;

// 계정이 없을 때 대조할 더미 해시. 어떤 비밀번호와도 맞지 않는다.
// 없으면 미가입 이메일은 scrypt 를 건너뛰어 즉시 401 이 되고, 그 시간차만으로
// 가입 여부를 훑을 수 있다. 모듈 로드 때 한 번만 계산한다.
const DUMMY_HASH = hashPassword(randomBytes(32).toString('hex'));

/** 직원 근무 앱(3팀 accounts) 로그인. */
@Injectable()
export class AccountAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AuthSessionService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const now = new Date();
    const email = dto.email.trim().toLowerCase();
    // 조회 키는 이메일뿐이다. 본인인증한 휴대전화번호는 초대 연결과 소속
    // 확인의 매칭 키일 뿐 로그인 아이디로 쓰지 않는다.
    const found = await this.prisma.account.findUnique({ where: { email } });
    // 탈퇴한 계정은 없는 계정으로 다룬다(ACC-15 — 탈퇴하지 않는 한 로그인된다). 같은 메시지,
    // 같은 비밀번호 검증 시간, 계정 없이 남는 이력까지 없는 이메일과 똑같다. 따로 처리하면
    // 응답이나 시간 차이로 그 이메일이 한때 가입돼 있었음이 드러난다. 잠금 상태이거나 실패가
    // 쌓여 있어도 탈퇴가 먼저다.
    const account = found?.status === 'WITHDRAWN' ? null : found;

    // 잠겨 있으면 비밀번호가 맞아도 들이지 않고, 검증도 하지 않는다. 잠금을
    // 푸는 길은 기다리는 것과 비밀번호를 다시 정하는 것뿐이다. 이 시도는
    // 실패 횟수에 더하지 않는다. 더하면 잠긴 계정에 시도를 계속 보내 남의
    // 잠금을 끝없이 미룰 수 있다.
    if (account && isLocked(this.stateOf(account), now)) {
      await this.sessions.recordLoginAttempt(
        this.failure(email, 'LOCKED', account.accountId),
      );
      throw this.locked();
    }

    // 계정이 없어도 검증을 돌린다. 메시지를 맞추는 것만으로는 부족하고,
    // 걸린 시간이 갈리면 그 차이만으로 가입 여부를 훑을 수 있다.
    const matched = await verifyPassword(
      dto.password,
      account?.passwordHash ?? (await DUMMY_HASH),
    );
    if (!account) {
      await this.sessions.recordLoginAttempt(
        this.failure(email, 'ACCOUNT_NOT_FOUND'),
      );
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }
    if (!matched) {
      const state = await this.countFailure(account.accountId, now);
      await this.sessions.recordLoginAttempt(
        this.failure(email, 'PASSWORD_MISMATCH', account.accountId),
      );
      // 이 실패로 5회를 채워 잠겼다면 지금 알린다.
      throw isLocked(state, now)
        ? this.locked()
        : new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    // 로그인에 성공하면 쌓인 실패는 연속이 끊긴 것이다. 지우지 않으면 몇 달에
    // 걸친 오타 5번이 정상 사용자를 잠근다. 지울 것이 없으면 쓰지 않는다.
    if (account.failedLoginCount > 0 || account.lockExpiresAt !== null)
      await this.prisma.account.update({
        where: { accountId: account.accountId },
        data: { failedLoginCount: 0, lockExpiresAt: null },
      });

    // 가입 연결이 보류된 계정(LINK_HOLD)도 막지 않는다. 막지 않는 대신
    // 상태를 응답에 담아 앱이 "관리자 확인 중"을 보여 줄 수 있게 한다.
    const session = await this.sessions.issue({
      accountId: account.accountId,
      deviceIdentifier: dto.deviceIdentifier,
    });

    const accessToken = await this.signAccessToken(
      account.accountId,
      account.email,
      session.authSessionId,
    );

    await this.sessions.recordLoginAttempt({
      accountId: account.accountId,
      email,
      isSucceeded: true,
    });

    return {
      accessToken,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      account: {
        accountId: account.accountId,
        email: account.email,
        realName: account.realName,
        status: account.status,
      },
    };
  }

  /**
   * 액세스 토큰을 새로 낸다. 갱신 토큰으로 접속을 이어 갈 때 쓴다. 갱신 토큰은
   * 회전하지 않는다 — 정책은 "마지막 사용 시각 + 30일"이고, 사용할 때마다
   * `validate` 가 만료를 뒤로 민다. 그래서 응답에는 갱신 토큰이 없고 새 만료
   * 시각만 있다.
   *
   * 만료·종료·없는 토큰은 접속 상태 서비스가 같은 메시지의 401 로 거부한다.
   */
  async refresh(refreshToken: string): Promise<RefreshResponseDto> {
    const session = await this.sessions.validate(refreshToken);
    // 이메일은 바뀔 수 있는 표시값이라 토큰에서 옮기지 않고 지금 행에서 읽는다.
    const account = await this.prisma.account.findUnique({
      where: { accountId: session.accountId },
      select: { email: true },
    });
    if (!account) throw new UnauthorizedException(INVALID_SESSION_MESSAGE);

    return {
      accessToken: await this.signAccessToken(
        session.accountId,
        account.email,
        session.authSessionId,
      ),
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  /** 로그아웃. 그 기기(접속 상태 하나)만 종료하고 다른 기기는 그대로 둔다. */
  async logout(authSessionId: number): Promise<void> {
    await this.sessions.revoke(authSessionId);
  }

  private signAccessToken(
    accountId: number,
    email: string,
    authSessionId: number,
  ): Promise<string> {
    // jti 가 없으면 같은 초에 두 번 발급했을 때 payload 도 iat 도 같아
    // 토큰이 바이트 단위로 같아진다.
    const claims: JwtPayload & { jti: string } = {
      sub: accountId,
      type: 'account',
      email,
      typ: 'access',
      // 이 토큰이 어느 접속 상태에서 나왔는지. 로그아웃·재설정으로 접속 상태가
      // 종료되면 남은 유효시간과 상관없이 거부하려면 가드가 이 값으로 확인한다.
      sid: authSessionId,
      jti: randomUUID(),
    };
    return this.jwt.signAsync(claims, { expiresIn: ACCESS_TTL });
  }

  /**
   * 틀린 시도를 한 번 센다. 행을 잠그고 읽어서 세는 것까지 한 트랜잭션이다.
   * 잠그지 않고 읽으면 동시에 들어온 틀린 시도가 모두 같은 횟수를 읽고 같은
   * 값을 써서, 병렬로 보내는 것만으로 5회 제한을 넘길 수 있다.
   */
  private countFailure(accountId: number, now: Date): Promise<AttemptState> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      const stored = await tx.account.findUniqueOrThrow({
        where: { accountId },
        select: { failedLoginCount: true, lockExpiresAt: true },
      });
      const current = this.stateOf(stored);
      const next = registerFailure(current, now);
      // 기다리는 사이 다른 요청이 먼저 잠갔으면 상태가 그대로 돌아온다.
      if (next !== current)
        await tx.account.update({
          where: { accountId },
          data: {
            failedLoginCount: next.failedCount,
            lockExpiresAt: next.lockExpiresAt,
          },
        });
      return next;
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

  private failure(
    email: string,
    failureReason: AccountLoginFailureReason,
    accountId?: number,
  ) {
    return {
      ...(accountId === undefined ? {} : { accountId }),
      email,
      isSucceeded: false,
      failureReason,
    };
  }
}
