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

/**
 * 관리자 웹 업무 API 의 메뉴 권한. 요청마다 현재 DB 의 권한 그룹으로 판정한다 — 저장하는 즉시 새 권한이 적용된다.
 * `@MenuPermission('MN000010', 'update')` 하나로 관리자 토큰 제한 · 표시 · 가드가 함께 붙는다.
 */
export const MenuPermission = (menuCode: string, action: MenuAction) =>
  applyDecorators(
    UserTypes('admin'),
    SetMetadata(MENU_PERMISSION, { menuCode, action }),
    UseGuards(MenuPermissionGuard),
  );

@Injectable()
export class MenuPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      { menuCode: string; action: MenuAction } | undefined
    >(MENU_PERMISSION, [context.getHandler(), context.getClass()]);
    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    // 표시 없이 가드만 붙은 경로를 열어 두면 제한 모양의 장치가 아무것도 하지 않는다.
    if (!required || user?.type !== 'admin')
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);

    const admin = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId: user.id,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: { roleGroupId: true },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const allowed = await this.prisma.roleGroupMenu.count({
      where: {
        roleGroupId: admin.roleGroupId,
        isDeleted: false,
        [COLUMN[required.action]]: true,
        roleGroup: { isDeleted: false },
        menu: {
          menuCode: required.menuCode,
          isDeleted: false,
          status: 'ACTIVE',
        },
      },
    });
    if (allowed === 0) throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    return true;
  }
}
