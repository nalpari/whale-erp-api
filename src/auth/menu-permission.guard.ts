import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
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

const MENU_ACTIONS: readonly string[] = [
  'read',
  'create',
  'update',
  'delete',
] satisfies MenuAction[];

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

/**
 * 데코레이터에 쓴 그대로의 표시. 동작이 하나면 `action` 은 문자열이다.
 * `menuCode` 가 없으면 메뉴는 컨트롤러 경로의 첫 단계로 찾는다.
 */
type MenuPermissionMeta = {
  menuCode?: string;
  action: MenuAction | readonly MenuAction[];
  platformOnly?: boolean;
};

/** menus.menu_code 의 CHECK 와 같은 형식. */
const MENU_CODE = /^MN[0-9]{6}$/;

/**
 * 관리자 웹 업무 API 의 메뉴 권한. 요청마다 현재 DB 의 권한 그룹으로 판정한다 — 저장하는 즉시 새 권한이 적용된다.
 * `@MenuPermission('update')` 하나로 관리자 토큰 제한 · 표시 · 가드가 함께 붙는다.
 * 동작을 배열로 주면 그중 하나만 있어도 통과한다(예: 등록 또는 수정 화면이 함께 쓰는 경로).
 *
 * 메뉴는 컨트롤러 경로의 첫 단계로 찾는다 — `@Controller('stores')` 면 menus.url 이 `/stores` 인 메뉴다(관리자 웹 화면
 * 주소와 API 자원 이름이 한 단계 경로로 같다는 정책, 2026-10-21 1팀 결정). 그래서:
 * - **메뉴 URL 이 권한 키다.** 플랫폼 메뉴 관리에서 메뉴 URL 을 바꾸면 그 API 의 권한이 바로 바뀐다(다른 메뉴 권한으로
 *   판정되거나, 맞는 메뉴가 없어 모두 403). 사용 중 메뉴끼리 URL 이 겹치지 않게 메뉴 저장이 막는다.
 * - 첫 단계가 메뉴를 정하므로 하위 경로(`/stores/:id/image` 등)는 모두 그 메뉴로 판정된다.
 * - 다른 메뉴로 판정해야 하는 경로는 `@MenuPermission('MN000010', 'update')` 처럼 메뉴 코드를 직접 준다(예외용).
 *
 * 메뉴 조건이 비면 Prisma 가 그 조건을 빼 아무 메뉴 권한으로나 통과하므로, 메뉴 코드 형식과 빈 동작 목록은
 * 클래스를 읽을 때 막는다 — 호출부 실수라 요청마다 403 이 아니라 부팅 실패다. 경로로 메뉴를 못 정하면(경로 없음 ·
 * 배열) 요청을 403 으로 막는다.
 *
 * 클래스와 메서드에 함께 달지 않는다. 가드는 메서드 표시가 있으면 그것만 읽어(getAllAndOverride) 클래스의
 * 동작 · platformOnly 가 조용히 빠진다.
 */
export function MenuPermission(
  action: MenuAction | readonly MenuAction[],
  options?: MenuPermissionOptions,
): ReturnType<typeof applyDecorators>;
export function MenuPermission(
  menuCode: `MN${string}`,
  action: MenuAction | readonly MenuAction[],
  options?: MenuPermissionOptions,
): ReturnType<typeof applyDecorators>;
export function MenuPermission(
  first: string | readonly MenuAction[],
  second?: MenuAction | readonly MenuAction[] | MenuPermissionOptions,
  third?: MenuPermissionOptions,
) {
  // 첫 인자가 동작(문자열 하나 · 배열)이면 경로 방식, 아니면 메뉴 코드 방식이다.
  const byPath = Array.isArray(first) || MENU_ACTIONS.includes(first as string);
  // 경로 방식에 메뉴 코드 방식의 꼴(동작 · 세 번째 인자)을 섞으면 두 번째 인자가 options 로 읽혀 platformOnly 가
  // 조용히 빠진다 — 넓어지는 실수라 부팅 때 막는다.
  if (
    byPath &&
    (typeof second === 'string' || Array.isArray(second) || third !== undefined)
  )
    throw new Error(
      '경로 방식은 (동작, options) 만 받습니다 — 메뉴 코드를 주려면 첫 인자에 MN 코드를 쓰세요',
    );
  const menuCode = byPath ? undefined : (first as string);
  const action = (byPath ? first : second) as
    MenuAction | readonly MenuAction[];
  const { platformOnly } = ((byPath ? second : third) ??
    {}) as MenuPermissionOptions;
  if (!byPath && !MENU_CODE.test(menuCode ?? ''))
    throw new Error(`메뉴 코드 형식이 아닙니다: ${menuCode}`);
  if (typeof action !== 'string' && !action?.length)
    throw new Error(`동작 목록이 비었습니다: ${menuCode ?? '경로 방식'}`);
  return applyDecorators(
    UserTypes('admin'),
    SetMetadata(MENU_PERMISSION, {
      ...(menuCode !== undefined && { menuCode }),
      action,
      ...(platformOnly && { platformOnly }),
    } satisfies MenuPermissionMeta),
    UseGuards(MenuPermissionGuard),
  );
}

/**
 * 컨트롤러 경로의 첫 단계를 메뉴 URL 로 — `'stores'` · `'/stores/x'` 는 `/stores`. 문자열이 아니거나(경로 배열 ·
 * @Controller 없음) 첫 단계가 비면 undefined. `req.url` 은 쿼리 · 끝 슬래시 · 전역 prefix 에 흔들려 쓰지 않는다.
 * `Reflect.getMetadata` 는 프로토타입 체인을 따라가므로 @Controller 없는 하위 클래스는 상위 클래스의 경로를 물려받는다.
 */
const menuUrlOf = (path: unknown): string | undefined => {
  if (typeof path !== 'string') return undefined;
  const first = path.replace(/^\/+/, '').split('/')[0];
  return first ? `/${first}` : undefined;
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
    // 메뉴 코드가 있으면 그 코드, 없으면 컨트롤러 경로의 첫 단계 URL. 빈 코드(SetMetadata 로 단 '')는 경로로 넘기지 않는다.
    const menuWhere = this.menuOf(required, context);
    if (!menuWhere || !actions.length)
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
          ...menuWhere,
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

  private menuOf(
    { menuCode }: MenuPermissionMeta,
    context: ExecutionContext,
  ): Prisma.MenuWhereInput | undefined {
    if (menuCode !== undefined) return menuCode ? { menuCode } : undefined;
    const url = menuUrlOf(
      Reflect.getMetadata(PATH_METADATA, context.getClass()) as unknown,
    );
    return url ? { url } : undefined;
  }
}
