import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  createParamDecorator,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ApiHeader } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { isPlatformRole } from '../admin-scope/admin-scope.service';
import { parseRouteId } from '../common/route-id';
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

/**
 * 네 동작 중 하나인가 — 목록을 따로 두지 않고 COLUMN 의 키로 본다. `in` 이 아니라 hasOwn 이라 'toString' 같은
 * Object 의 속성 이름은 동작이 아니다(그대로 쓰면 COLUMN[action] 이 함수가 되어 Prisma 500).
 */
export const isMenuAction = (v: unknown): v is MenuAction =>
  typeof v === 'string' && Object.hasOwn(COLUMN, v);

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
  menuCode?: `MN${string}`;
  action: MenuAction | readonly MenuAction[];
  platformOnly?: boolean;
};

/** 이 탭이 다루는 BP — front proxy · bff() 가 화면 주소 `/bp/{bpCodeId}/...` 에서 붙인다. */
export const BP_HEADER = 'X-Bp-Code-Id';

/** 다른 BP 를 부른 BP · 가맹 계정. */
export const OTHER_BP_MESSAGE = '다른 BP 의 정보는 다룰 수 없습니다.';
const BP_NOT_FOUND_MESSAGE = 'BP 를 찾을 수 없습니다';

/**
 * WHALE_ERP 메뉴 경로에서 가드가 정한 대상 BP. `request.user`(누가)와 따로 둔다 — 대상 BP 는 이 경로에서만 정해진다.
 * isPlatformCaller 는 플랫폼 계정(플랫폼 BP 의 PM · PA)이 부른 것인가 — 헤더가 없으면 bpCodeId 는 플랫폼 BP 다.
 */
export type TargetBpContext = { bpCodeId: number; isPlatformCaller: boolean };

/** menus.menu_code 의 CHECK 와 같은 형식. */
const MENU_CODE = /^MN[0-9]{6}$/;

/**
 * 관리자 웹 업무 API 의 메뉴 권한. 요청마다 현재 DB 의 권한 그룹으로 판정한다 — 저장하는 즉시 새 권한이 적용된다.
 * `@MenuPermission('update')` 하나로 관리자 토큰 제한 · 표시 · 가드가 함께 붙는다.
 * 동작을 배열로 주면 그중 하나만 있어도 통과한다(예: 등록 또는 수정 화면이 함께 쓰는 경로).
 *
 * 메뉴는 컨트롤러 경로의 첫 단계로 찾는다 — `@Controller('stores')` 면 menus.url 이 `/stores` 인 메뉴다(관리자 웹 화면
 * 주소와 API 자원 이름이 한 단계 경로로 같다는 정책, 2026-10-21 1팀 결정). 그래서:
 * - **메뉴 URL 이 권한 키다.** URL 을 바꾸면 그 API 의 권한이 바뀌므로(다른 메뉴 권한으로 판정되는 권한 상승,
 *   맞는 메뉴가 없어 모두 403 인 잠김), 플랫폼 메뉴 관리가 API 경로에 묶인 메뉴 URL 은 바꾸지도 다른 메뉴가 가져가지도
 *   못하게 막는다(ApiMenuUrlsService). 주소를 옮기려면 컨트롤러 경로와 함께 마이그레이션으로 바꾼다.
 * - URL 겹침은 메뉴 저장 검증(사용 중 메뉴끼리 같거나 접두어로 겹치면 409)과 DB 부분 유니크 인덱스
 *   (menus_url_active_key — 사용 중 · 지우지 않은 메뉴의 같은 URL)가 막는다.
 * - 첫 단계가 메뉴를 정하므로 하위 경로(`/stores/:id/image` 등)는 모두 그 메뉴로 판정된다.
 * - 다른 메뉴로 판정해야 하는 경로는 `@MenuPermission('MN000010', 'update')` 처럼 메뉴 코드를 직접 준다(예외용,
 *   1팀 결정으로 남겨 둔다).
 *
 * 메뉴 조건이 비면 Prisma 가 그 조건을 빼 아무 메뉴 권한으로나 통과하므로, 메뉴 코드 형식과 빈 동작 목록 · 동작이
 * 아닌 원소는 클래스를 읽을 때 막는다 — 호출부 실수라 요청마다 403 이 아니라 부팅 실패다.
 *
 * 403 이 되는 경우: 관리자 토큰이 아님, 계정을 쓸 수 없음, 권한 행 없음, platformOnly 인데 플랫폼 계정이 아님, 그리고
 * 경로로 메뉴를 못 정할 때(@Controller 없음 · 빈 경로 · `@Controller()` 의 `'/'` · 경로 배열). **함정**: 경로 방식
 * 데코레이터를 경로 없는 컨트롤러에 달면 부팅이 아니라 요청마다 403 이다 — 데코레이터는 자기가 어느 컨트롤러에
 * 붙을지 모른다. 판정할 사용 중 메뉴 자체가 없어 거절하면 로그(error)를 남긴다.
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
  const byPath = Array.isArray(first) || isMenuAction(first);
  // 경로 방식에 메뉴 코드 방식의 꼴(동작 · 세 번째 인자)을 섞으면 그 동작이나 세 번째 인자의 platformOnly 가
  // 조용히 빠진다 — 넓어지는 실수라 부팅 때 막는다.
  if (
    byPath &&
    (typeof second === 'string' || Array.isArray(second) || third !== undefined)
  )
    throw new Error(
      '경로 방식은 (동작, options) 만 받습니다 — 메뉴 코드를 주려면 첫 인자에 MN 코드를 쓰세요',
    );
  const menuCode = byPath ? undefined : (first as `MN${string}`);
  const action = (byPath ? first : second) as
    MenuAction | readonly MenuAction[];
  const { platformOnly } = ((byPath ? second : third) ??
    {}) as MenuPermissionOptions;
  if (!byPath && !MENU_CODE.test(menuCode ?? ''))
    throw new Error(`메뉴 코드 형식이 아닙니다: ${menuCode}`);
  if (typeof action !== 'string' && !action?.length)
    throw new Error(`동작 목록이 비었습니다: ${menuCode ?? '경로 방식'}`);
  const actions: readonly unknown[] = Array.isArray(action) ? action : [action];
  const bad = actions.findIndex((a) => !isMenuAction(a));
  if (bad >= 0)
    throw new Error(
      `동작이 아닙니다: ${String(actions[bad])} (${menuCode ?? '경로 방식'})`,
    );
  return applyDecorators(
    UserTypes('admin'),
    ApiHeader({
      name: BP_HEADER,
      required: false,
      description:
        '대상 BP(bpCodeId). WHALE_ERP 메뉴 경로에서만 읽는다 — 없으면 소속 BP. 플랫폼 계정은 없는 BP · 플랫폼 BP 면 404, BP · 가맹 계정은 소속 BP 가 아니면 403',
    }),
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
export const menuUrlOf = (path: unknown): string | undefined => {
  if (typeof path !== 'string') return undefined;
  const first = path.replace(/^\/+/, '').split('/')[0];
  return first ? `/${first}` : undefined;
};

type MenuWhere = { menuCode: string } | { url: string };

/** 이 역할 그룹에 그 메뉴의 동작(하나라도) 권한 행이 있는가 — 사용 중 메뉴 · 지우지 않은 그룹 · 행만 */
const menuActionWhere = (
  roleGroupId: number,
  menuWhere: MenuWhere,
  actions: readonly MenuAction[],
): Prisma.RoleGroupMenuWhereInput => ({
  roleGroupId,
  isDeleted: false,
  OR: actions.map((action) => ({ [COLUMN[action]]: true })),
  roleGroup: { isDeleted: false },
  menu: { ...menuWhere, isDeleted: false, status: 'ACTIVE' },
});

/**
 * 관리자가 그 메뉴의 동작 권한을 가졌는가 — 가드와 같은 판정이다. 데코레이터는 경로만 보므로, 한 경로가 대상의 상태에
 * 따라 다른 동작이 되거나(근로계약 이어 쓰기 PUT 은 임시저장이면 작성, 수정 요청이면 수정) 다른 대상을 함께 바꿀 때
 * (대체) 서비스가 상태를 읽은 뒤 이것으로 다시 묻는다(WHALEERP-592). 쓸 수 없는 계정이면 false.
 */
export async function adminHasMenuAction(
  db: Pick<Prisma.TransactionClient, 'adminAccount' | 'roleGroupMenu'>,
  adminAccountId: number,
  menuWhere: MenuWhere,
  actions: readonly MenuAction[],
): Promise<boolean> {
  const admin = await db.adminAccount.findFirst({
    where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
    select: { roleGroupId: true },
  });
  if (!admin) return false;
  return (
    (await db.roleGroupMenu.count({
      where: menuActionWhere(admin.roleGroupId, menuWhere, actions),
    })) > 0
  );
}

@Injectable()
export class MenuPermissionGuard implements CanActivate {
  private readonly logger = new Logger(MenuPermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      MenuPermissionMeta | undefined
    >(MENU_PERMISSION, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<{
      user?: AuthUser;
      headers: Record<string, string | string[] | undefined>;
      bp?: TargetBpContext;
    }>();
    const { user } = request;
    // 표시 없이 가드만 붙은 경로를 열어 두면 제한 모양의 장치가 아무것도 하지 않는다.
    if (!required || user?.type !== 'admin')
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    const actions: readonly unknown[] = Array.isArray(required.action)
      ? required.action
      : [required.action];
    // 데코레이터가 막지만, SetMetadata 로 직접 단 표시도 메뉴 조건 · 동작 없이(또는 동작이 아닌 값으로) 통과하거나
    // Prisma 500 이 되지 않게 한 번 더 본다.
    const menuWhere = this.menuOf(required, context);
    if (!menuWhere || !actions.length || !actions.every(isMenuAction))
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
        bpCodeId: true,
        bpCode: { select: { isPlatform: true } },
      },
    });
    if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    // url · menu_code 는 사용 중 메뉴끼리 겹치지 않아 행은 많아야 하나다 — 그 메뉴의 서비스를 같은 쿼리로 읽는다.
    const allowed = await this.prisma.roleGroupMenu.findFirst({
      where: menuActionWhere(admin.roleGroupId, menuWhere, actions),
      select: { menu: { select: { serviceCode: true } } },
    });
    if (!allowed) {
      await this.reportMissingMenu(menuWhere, context);
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    }
    if (
      required.platformOnly &&
      !isPlatformRole(admin.roleTypeCode, admin.bpCode.isPlatform)
    )
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    if (allowed.menu.serviceCode === 'WHALE_ERP')
      request.bp = await this.targetBp(admin, request.headers);
    return true;
  }

  /**
   * WHALE_ERP 메뉴 경로의 대상 BP. 헤더가 없으면 소속 BP — 아직 옮기지 않은 화면은 보내지 않는다(전환 기간).
   * 플랫폼 계정은 헤더의 고객 BP(없거나 지웠거나 플랫폼 BP 면 404), BP · 가맹 계정은 소속 BP 만(다르면 403).
   * 소속 BP 는 DB 의 계정 값이다 — 쿼리 · body · 쿠키는 기준이 아니다.
   */
  private async targetBp(
    admin: {
      roleTypeCode: string;
      bpCodeId: number;
      bpCode: { isPlatform: boolean };
    },
    headers: Record<string, string | string[] | undefined>,
  ): Promise<TargetBpContext> {
    const isPlatformCaller = isPlatformRole(
      admin.roleTypeCode,
      admin.bpCode.isPlatform,
    );
    const raw = headers[BP_HEADER.toLowerCase()];
    if (raw === undefined)
      return { bpCodeId: admin.bpCodeId, isPlatformCaller };
    // 형식이 틀리거나 두 번 온 헤더는 어느 BP 도 아니다 — 없는 BP 와 같게 답한다.
    const bpCodeId = typeof raw === 'string' ? parseRouteId(raw) : null;
    if (!isPlatformCaller) {
      if (bpCodeId !== admin.bpCodeId)
        throw new ForbiddenException(OTHER_BP_MESSAGE);
      return { bpCodeId: admin.bpCodeId, isPlatformCaller };
    }
    const bp =
      bpCodeId === null
        ? null
        : await this.prisma.bpCode.findFirst({
            where: { bpCodeId, isDeleted: false, isPlatform: false },
            select: { bpCodeId: true },
          });
    if (!bp) throw new NotFoundException(BP_NOT_FOUND_MESSAGE);
    return { bpCodeId: bp.bpCodeId, isPlatformCaller };
  }

  /**
   * 메뉴 코드 키가 있으면 그 코드(비었거나 undefined 면 판정 불가 — 경로로 넘기면 다른 메뉴로 판정된다), 없으면
   * 컨트롤러 경로의 첫 단계 URL.
   */
  private menuOf(
    required: MenuPermissionMeta,
    context: ExecutionContext,
  ): { menuCode: string } | { url: string } | undefined {
    if ('menuCode' in required)
      return required.menuCode ? { menuCode: required.menuCode } : undefined;
    const url = menuUrlOf(
      Reflect.getMetadata(PATH_METADATA, context.getClass()) as unknown,
    );
    return url ? { url } : undefined;
  }

  /**
   * 거절할 때만 — 판정할 사용 중 메뉴가 아예 없으면 권한이 없는 게 아니라 설정이 어긋난 것이다(메뉴 URL 변경 ·
   * 사용중지, 컨트롤러 경로 오타). 응답은 그대로 403 이고, 운영자가 원인을 찾게 로그를 남긴다. 이 조회가 실패해도
   * 로그만 남기고 403 으로 둔다 — 진단 때문에 거절이 500 이 되지 않게.
   */
  private async reportMissingMenu(
    menuWhere: { menuCode: string } | { url: string },
    context: ExecutionContext,
  ): Promise<void> {
    const where = `${context.getClass().name}: ${
      'url' in menuWhere
        ? `url ${menuWhere.url}`
        : `menuCode ${menuWhere.menuCode}`
    }`;
    try {
      const exists = await this.prisma.menu.count({
        where: { ...menuWhere, isDeleted: false, status: 'ACTIVE' },
      });
      if (exists === 0)
        this.logger.error(
          `메뉴 권한 판정에 쓸 사용 중 메뉴가 없습니다 — ${where}`,
        );
    } catch (error) {
      this.logger.error(
        `메뉴 권한 거절 뒤 메뉴 확인 실패 — ${where}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/**
 * 가드가 정한 대상 BP. WHALE_ERP 메뉴의 `@MenuPermission` 경로에서만 쓴다 — 가드가 BP 를 정하지 않은 경로(플랫폼
 * 메뉴 · 가드 없음)에서 쓰면 500 이다. 빠뜨린 가드를 조용히 소속 BP 로 메우지 않고 개발 중에 드러낸다.
 */
export const TargetBp = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TargetBpContext => {
    const { bp } = ctx.switchToHttp().getRequest<{ bp?: TargetBpContext }>();
    if (!bp)
      throw new InternalServerErrorException(
        '대상 BP 가 정해지지 않은 경로입니다 — WHALE_ERP 메뉴의 @MenuPermission 이 필요합니다',
      );
    return bp;
  },
);
