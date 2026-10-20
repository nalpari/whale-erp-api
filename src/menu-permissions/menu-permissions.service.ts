import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';

/** 메뉴별 권한(role_group_menus)의 네 동작 — 조회 · 등록 · 수정 · 삭제. */
export type MenuAction = 'read' | 'create' | 'update' | 'delete';

const FLAG = {
  read: 'isReadable',
  create: 'isCreatable',
  update: 'isUpdatable',
  delete: 'isDeletable',
} as const;

/**
 * 사용 중인 호출 관리자의 권한 유형 · 권한 그룹. 메뉴 권한은 `@MenuPermission` 가드나 `assert` 가 본다.
 * 마스터 보호 · 본인 보호처럼 동작 안에서 더 가르는 데 쓴다.
 */
export type MenuCaller = {
  adminAccountId: number;
  roleTypeCode: string;
  roleGroupId: number;
};

/**
 * 관리자 웹의 메뉴 권한 판정. 호출한 관리자의 권한 그룹이 그 메뉴에 그 동작 권한을 가져야 한다.
 *
 * 기본은 `@MenuPermission` 가드다. 이 서비스는 가드 뒤에 호출자를 읽는 `caller()` 와, 가드로 못 하는 판정(본문 ·
 * 쿼리 · 글에 따라 메뉴 · 동작이 갈리는 경우)에 쓰는 `assert` 를 준다.
 *
 * 세션 가드(JwtAuthGuard)는 관리자 세션만 보고 계정 상태는 보지 않으므로(미사용 · 탈퇴는 갱신에서 끊긴다, 최대 1시간)
 * 지운 계정 · 사용중지 · 탈퇴 계정도 여기서 막는다. 권한을 바꾸면 다시 로그인하지 않아도 다음 요청부터 맞는다 — 매번 DB 를 읽는다.
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

  async assert(
    adminAccountId: number,
    menuCode: string,
    action: MenuAction,
  ): Promise<MenuCaller> {
    // 비면 Prisma 가 메뉴 조건을 빼 버려 아무 메뉴 권한으로나 통과한다. 호출부 실수라 403 이 아니라 500 이다.
    if (!menuCode) throw new Error('메뉴 코드가 비었습니다');
    const caller = await this.caller(adminAccountId);

    const grant = await this.prisma.roleGroupMenu.findFirst({
      where: {
        roleGroupId: caller.roleGroupId,
        isDeleted: false,
        roleGroup: { isDeleted: false },
        menu: { menuCode, isDeleted: false, status: 'ACTIVE' },
      },
      select: {
        isReadable: true,
        isCreatable: true,
        isUpdatable: true,
        isDeletable: true,
      },
    });
    if (!grant?.[FLAG[action]])
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    return caller;
  }
}
