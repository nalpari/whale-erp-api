import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';

/**
 * 사용 중인 호출 관리자의 권한 유형 · 권한 그룹. 메뉴 권한은 `@MenuPermission` 가드가 본다.
 * 마스터 보호 · 본인 보호처럼 동작 안에서 더 가르는 데 쓴다.
 */
export type MenuCaller = {
  adminAccountId: number;
  roleTypeCode: string;
  roleGroupId: number;
};

/**
 * 가드 뒤에 서비스가 호출자를 읽는 `caller()` 만 준다. 메뉴 권한 판정은 `@MenuPermission` 가드가 한다.
 *
 * 세션 가드(JwtAuthGuard)는 관리자 세션만 보고 계정 상태는 보지 않으므로(미사용 · 탈퇴는 갱신에서 끊긴다, 최대 1시간)
 * 지운 계정 · 사용중지 · 탈퇴 계정도 여기서 막는다 — 매번 DB 를 읽는다.
 */
@Injectable()
export class MenuPermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 호출한 관리자. `@MenuPermission` 가드를 통과한 경로의 서비스가 마스터 보호 · 본인 보호에 쓸 권한 유형 · 권한
   * 그룹을 읽는다. 가드와 이 조회 사이에 계정이 사용중지 · 탈퇴 · 삭제됐으면 가드와 같은 계정 403 이다.
   */
  async caller(adminAccountId: number): Promise<MenuCaller> {
    const caller = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { adminAccountId: true, roleTypeCode: true, roleGroupId: true },
    });
    if (!caller) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    return caller;
  }
}
