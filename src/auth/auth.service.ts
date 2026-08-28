import { randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, JwtPayload, UserType } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token.response.dto';
import { hashToken, verifyPassword } from './password';

interface AuthRow {
  id: number;
  email: string;
  name: string;
  passwordHash: string;
  refreshTokenHash: string | null;
}

// staff 와 customers 는 컬럼이 같아 델리게이트를 한 타입으로 다룰 수 있다.
// Prisma 가 만든 두 델리게이트의 유니온은 호출 시그니처가 합쳐지지 않아
// 그대로는 못 부르므로, 여기서 쓰는 두 메서드만 좁혀 캐스팅한다.
interface AuthRepo {
  findUnique(args: {
    where: { email: string } | { id: number };
  }): Promise<AuthRow | null>;
  update(args: {
    where: { id: number };
    data: { refreshTokenHash: string | null };
  }): Promise<unknown>;
}

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';

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
    // 계정이 없을 때와 비밀번호가 틀릴 때의 응답이 달라지면, 그 차이만으로
    // 가입 여부를 훑을 수 있다. 두 경우를 같은 예외로 합친다.
    if (!user || !(await verifyPassword(dto.password, user.passwordHash)))
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
    // 저장된 해시와 다르면 이미 회전됐거나(재사용) 로그아웃된 토큰이다.
    if (!user || user.refreshTokenHash !== hashToken(refreshToken))
      throw new UnauthorizedException('만료되었거나 폐기된 토큰입니다');

    return this.issue(payload.type, user);
  }

  async logout(user: AuthUser): Promise<void> {
    await this.repo(user.type).update({
      where: { id: user.id },
      data: { refreshTokenHash: null },
    });
  }

  private async issue(
    type: UserType,
    user: AuthRow,
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
    await this.repo(type).update({
      where: { id: user.id },
      data: { refreshTokenHash: hashToken(refreshToken) },
    });

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, type },
    };
  }
}
