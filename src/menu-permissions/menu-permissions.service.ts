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

/** 권한을 확인한 호출자. 마스터 보호 · 본인 보호처럼 동작 안에서 더 가르는 데 쓴다. */
export type MenuCaller = {
  adminAccountId: number;
  roleTypeCode: string;
  roleGroupId: number;
};

/**
 * 관리자 웹의 메뉴 권한 판정. 호출한 관리자의 권한 그룹이 그 메뉴에 그 동작 권한을 가져야 한다.
 *
 * 가드는 관리자 세션만 보고 계정 상태는 보지 않으므로(미사용 · 탈퇴는 갱신에서 끊긴다, 최대 1시간)
 * 지운 계정 · 사용중지 · 탈퇴 계정도 여기서 막는다. 권한을 바꾸면 다시 로그인하지 않아도 다음 요청부터 맞는다 — 매번 DB 를 읽는다.
 */
@Injectable()
export class MenuPermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async assert(
    adminAccountId: number,
    menuCode: string,
    action: MenuAction,
  ): Promise<MenuCaller> {
    // 비면 Prisma 가 메뉴 조건을 빼 버려 아무 메뉴 권한으로나 통과한다. 호출부 실수라 403 이 아니라 500 이다.
    if (!menuCode) throw new Error('메뉴 코드가 비었습니다');
    const caller = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { adminAccountId: true, roleTypeCode: true, roleGroupId: true },
    });
    if (!caller) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);

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
