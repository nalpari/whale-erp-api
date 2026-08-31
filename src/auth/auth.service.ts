import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, JwtPayload, UserType } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token.response.dto';
import { hashPassword, hashToken, verifyPassword } from './password';

interface AuthRow {
  id: number;
  email: string;
  name: string;
  passwordHash: string;
  refreshTokenHash: string | null;
}

// staff 와 customers 는 컬럼이 같아 델리게이트를 한 타입으로 다룰 수 있다.
// 여기서 쓰는 메서드만 남긴 좁은 타입으로 받아, 두 테이블을 한 코드로 다룬다.
interface AuthRepo {
  findUnique(args: {
    where: { email: string } | { id: number };
  }): Promise<AuthRow | null>;
  // update 가 아니라 updateMany 다. update 는 행이 없으면 P2025 를 던져
  // 평범한 로그아웃이 500 이 되고, where 에 조건을 더해 조건부 갱신을
  // 표현할 수도 없다.
  updateMany(args: {
    where: { id: number; refreshTokenHash?: string | null };
    data: { refreshTokenHash: string | null };
  }): Promise<{ count: number }>;
}

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';

// 계정이 없을 때 대조할 더미 해시. 어떤 비밀번호와도 맞지 않는다.
// 없으면 미가입 이메일은 scrypt 를 건너뛰어 즉시 401 이 되고, 그 시간차만으로
// 가입 여부를 훑을 수 있다. 모듈 로드 때 한 번만 계산한다.
const DUMMY_HASH = hashPassword(randomBytes(32).toString('hex'));

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private repo(type: UserType): AuthRepo {
    const delegate =
      type === 'staff' ? this.prisma.staff : this.prisma.customer;
    return delegate;
  }

  async login(type: UserType, dto: LoginDto): Promise<TokenResponseDto> {
    const user = await this.repo(type).findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });
    // 계정이 없어도 검증을 돌린다. 메세지를 맞추는 것만으로는 부족하고,
    // 걸린 시간이 갈리면 그 차이만으로 가입 여부를 훑을 수 있다.
    const matched = await verifyPassword(
      dto.password,
      user?.passwordHash ?? (await DUMMY_HASH),
    );
    if (!user || !matched)
      throw new UnauthorizedException(
        '이메일 또는 비밀번호가 올바르지 않습니다',
      );

    return this.issue(type, user);
  }

  async refresh(refreshToken: string): Promise<TokenResponseDto> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('리프레시 토큰이 유효하지 않습니다');
    }
    if (payload.typ !== 'refresh')
      throw new UnauthorizedException('리프레시 토큰이 아닙니다');

    // 이메일이 아니라 sub 로 찾는다. 토큰이 가리키는 주체는 id 이고,
    // 이메일은 바뀔 수 있는 표시값이다.
    const user = await this.repo(payload.type).findUnique({
      where: { id: payload.sub },
    });
    if (!user)
      throw new UnauthorizedException('만료되었거나 폐기된 토큰입니다');

    const presented = hashToken(refreshToken);
    if (user.refreshTokenHash !== presented) {
      // 서명은 멀쩡한데 저장된 해시와 다르다 = 이미 회전된 토큰의 재사용.
      // 탈취 신호로 보고 살아 있는 세션까지 끊는다. 이 요청만 막으면
      // 먼저 회전시킨 쪽(공격자일 수 있다)이 세션을 그대로 가져간다.
      await this.revoke(payload.type, user.id);
      throw new UnauthorizedException('만료되었거나 폐기된 토큰입니다');
    }

    return this.issue(payload.type, user, presented);
  }

  async logout(user: AuthUser): Promise<void> {
    await this.revoke(user.type, user.id);
  }

  private async revoke(type: UserType, id: number): Promise<void> {
    await this.repo(type).updateMany({
      where: { id },
      data: { refreshTokenHash: null },
    });
  }

  /**
   * @param expected 회전일 때 직전 리프레시 해시. 갱신 조건으로 걸어
   *   읽기-비교-쓰기를 원자적 한 문장으로 만든다. 로그인이면 생략한다.
   */
  private async issue(
    type: UserType,
    user: AuthRow,
    expected?: string,
  ): Promise<TokenResponseDto> {
    // jti 가 없으면 같은 초에 두 번 발급했을 때 payload 도 iat 도 같아
    // 토큰이 바이트 단위로 동일해진다. 회전이 아무것도 바꾸지 못하고
    // 직전 토큰이 계속 통과한다.
    const claims = { sub: user.id, type, email: user.email, jti: randomUUID() };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { ...claims, typ: 'access' },
        { expiresIn: ACCESS_TTL },
      ),
      this.jwt.signAsync(
        { ...claims, typ: 'refresh' },
        { expiresIn: REFRESH_TTL },
      ),
    ]);

    // 발급할 때마다 덮어쓴다. 결과적으로 한 계정당 유효한 리프레시 토큰은
    // 하나뿐이라, 다른 기기에서 로그인하면 이전 기기의 갱신이 끊긴다.
    // ponytail: 단일 세션. 다중 기기가 필요해지면 refresh_tokens 테이블로 분리.
    const { count } = await this.repo(type).updateMany({
      where:
        expected === undefined
          ? { id: user.id }
          : { id: user.id, refreshTokenHash: expected },
      data: { refreshTokenHash: hashToken(refreshToken) },
    });
    if (count === 0) {
      // 조건이 안 맞았다 = 제시된 토큰이 이미 소비됐다. 회전된 옛 토큰의
      // 재사용이거나, 같은 토큰을 든 동시 요청 중 진 쪽이다. 둘을 구분할 수
      // 없고 전자는 탈취 신호이므로, 먼저 소비한 쪽의 세션까지 끊는다.
      // 이 요청만 막으면 정상 사용자만 튕기고 공격자가 세션을 가져간다.
      // 대가로 클라이언트가 갱신을 동시에 두 번 쏘면 로그아웃된다.
      // ponytail: 갱신 요청 직렬화는 클라이언트 몫. 서버에서 구분하려면
      // 토큰 계열(family) 테이블이 필요하다.
      if (expected !== undefined) await this.revoke(type, user.id);
      throw new UnauthorizedException('만료되었거나 폐기된 토큰입니다');
    }

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, type },
    };
  }
}
