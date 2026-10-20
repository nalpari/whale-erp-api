import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { isPlatformRole } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { UserTypes } from './auth.decorators';
import type { AuthUser } from './auth.types';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from './access-messages';

export const MENU_PERMISSION = 'menuPermission';

export type MenuAction = 'read' | 'create' | 'update' | 'delete';

const COLUMN = {
  read: 'isReadable',
  create: 'isCreatable',
  update: 'isUpdatable',
  delete: 'isDeletable',
} as const satisfies Record<MenuAction, keyof Prisma.RoleGroupMenuWhereInput>;

// 관리자 웹 화면은 로그인 때 받은 권한으로 그려져, 그 뒤 권한이 바뀌면 버튼이 남아 있을 수 있다.
// 그래서 거절 문구가 다시 로그인을 안내한다(front okf auth.md, 2026-10-13).

export type MenuPermissionOptions = {
  /** 메뉴 권한에 더해 플랫폼 BP 의 PM · PA 여야 한다 — 권한 행이 BP 쪽 그룹에 잘못 붙어도 플랫폼 화면을 열지 못하게. */
  platformOnly?: boolean;
};

/** 데코레이터에 쓴 그대로의 표시. 동작이 하나면 `action` 은 문자열이다. */
type MenuPermissionMeta = {
  menuCode: string;
  action: MenuAction | readonly MenuAction[];
  platformOnly?: boolean;
};

/** menus.menu_code 의 CHECK 와 같은 형식. */
const MENU_CODE = /^MN[0-9]{6}$/;

/**
 * 관리자 웹 업무 API 의 메뉴 권한. 요청마다 현재 DB 의 권한 그룹으로 판정한다 — 저장하는 즉시 새 권한이 적용된다.
 * `@MenuPermission('MN000010', 'update')` 하나로 관리자 토큰 제한 · 표시 · 가드가 함께 붙는다.
 * 동작을 배열로 주면 그중 하나만 있어도 통과한다(예: 등록 또는 수정 화면이 함께 쓰는 경로).
 *
 * 메뉴 코드가 비면 Prisma 가 메뉴 조건을 빼 아무 메뉴 권한으로나 통과하므로, 메뉴 코드 형식과 빈 동작 목록은
 * 클래스를 읽을 때 막는다 — 호출부 실수라 요청마다 403 이 아니라 부팅 실패다.
 *
 * 클래스와 메서드에 함께 달지 않는다. 가드는 메서드 표시가 있으면 그것만 읽어(getAllAndOverride) 클래스의
 * 동작 · platformOnly 가 조용히 빠진다.
 */
export const MenuPermission = (
  menuCode: string,
  action: MenuAction | readonly MenuAction[],
  { platformOnly }: MenuPermissionOptions = {},
) => {
  if (!MENU_CODE.test(menuCode ?? ''))
    throw new Error(`메뉴 코드 형식이 아닙니다: ${menuCode}`);
  if (typeof action !== 'string' && !action.length)
    throw new Error(`동작 목록이 비었습니다: ${menuCode}`);
  return applyDecorators(
    UserTypes('admin'),
    SetMetadata(MENU_PERMISSION, {
      menuCode,
      action,
      ...(platformOnly && { platformOnly }),
    } satisfies MenuPermissionMeta),
    UseGuards(MenuPermissionGuard),
  );
};

@Injectable()
export class MenuPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      MenuPermissionMeta | undefined
    >(MENU_PERMISSION, [context.getHandler(), context.getClass()]);
    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    // 표시 없이 가드만 붙은 경로를 열어 두면 제한 모양의 장치가 아무것도 하지 않는다.
    if (!required || user?.type !== 'admin')
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    const actions: readonly MenuAction[] =
      typeof required.action === 'string' ? [required.action] : required.action;
    // 데코레이터가 막지만, SetMetadata 로 직접 단 표시도 메뉴 조건 · 동작 없이 통과하지 않게 한 번 더 본다.
    if (!required.menuCode || !actions.length)
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);

    const admin = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: user.id,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: {
        roleGroupId: true,
        roleTypeCode: true,
        bpCode: { select: { isPlatform: true } },
      },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const allowed = await this.prisma.roleGroupMenu.count({
      where: {
        roleGroupId: admin.roleGroupId,
        isDeleted: false,
        OR: actions.map((action) => ({ [COLUMN[action]]: true })),
        roleGroup: { isDeleted: false },
        menu: {
          menuCode: required.menuCode,
          isDeleted: false,
          status: 'ACTIVE',
        },
      },
    });
    if (allowed === 0) throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    if (
      required.platformOnly &&
      !isPlatformRole(admin.roleTypeCode, admin.bpCode.isPlatform)
    )
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    return true;
  }
}
