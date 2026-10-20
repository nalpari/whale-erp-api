import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, UseStatus } from '@prisma/client';
import { PLATFORM_BP_CODE } from '../codes/codes.service';
import { sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreatePlatformMenuResponseDto,
  PlatformMenuDetailResponseDto,
  PlatformMenuNodeResponseDto,
  PlatformMenuServiceListResponseDto,
  PlatformMenuTreeResponseDto,
} from './dto/platform-menu.response.dto';
import type {
  CreatePlatformMenuDto,
  MovePlatformMenuDto,
  UpdatePlatformMenuDto,
} from './dto/save-platform-menu.dto';
import {
  CHANGED_MEANWHILE,
  MENU_URL_ONE_SEGMENT,
  MENU_URL_ONE_SEGMENT_MESSAGE,
  NOT_FOUND,
  PLATFORM_MASTER_ROLE_CODE,
  SERVICE_NOT_FOUND,
} from './platform-menu-format';
import {
  hiddenMenuIds,
  MAX_MENU_DEPTH,
  nextMenuCode,
  planMove,
  siblingsOf,
  TOO_DEEP,
  urlsOverlap,
} from './platform-menu-rules';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const SERVICE_GROUP = 'SERVICE';
const ACTOR = { select: { name: true, loginId: true } } as const;
const MENU_SELECT = {
  menuId: true,
  menuCode: true,
  serviceCode: true,
  parentMenuId: true,
  name: true,
  url: true,
  sortOrder: true,
  depth: true,
  status: true,
} as const satisfies Prisma.MenuSelect;
type MenuRecord = Prisma.MenuGetPayload<{ select: typeof MENU_SELECT }>;

/** 쓰기 트랜잭션 시간. 모든 쓰기가 메뉴 잠금에 줄을 서므로 기본값(대기 2초 · 실행 5초)보다 넉넉히 둔다(점포 등록과 같다). */
const MENU_WRITE_TX = { maxWait: 5_000, timeout: 15_000 };

/**
 * 플랫폼 메뉴 관리(MN000215, S-GXMZOU · F-CWWQUR) — 서비스 탭, 서비스별 메뉴 트리, 상세, 등록, 노출 메뉴명 · URL ·
 * 사용 상태 수정, 위치 옮기기. 메뉴는 지우지 않고 사용중지로 돌린다. 변경 이력은 두지 않는다(정책).
 *
 * 쓰기(등록 · 수정 · 옮기기)는 하나의 advisory lock 으로 줄 세운다 — 순서 다시 매기기 · 채번 · URL 겹침 검사가 모두
 * 「읽고 판단하고 쓴다」라서, 관리자 몇 명이 드물게 쓰는 화면에 잠금 하나가 가장 단순하고 안전하다.
 */
@Injectable()
export class PlatformMenusService {
  private readonly logger = new Logger(PlatformMenusService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 서비스 탭 — 공통코드 SERVICE 전부(사용중지 포함)와 메뉴 수. */
  async services(): Promise<PlatformMenuServiceListResponseDto> {
    const [services, menus] = await Promise.all([
      this.prisma.codeItem.findMany({
        where: {
          groupCode: SERVICE_GROUP,
          bpCode: PLATFORM_BP_CODE,
          isDeleted: false,
        },
        orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
        select: { itemCode: true, label: true, status: true },
      }),
      this.prisma.menu.findMany({
        where: { isDeleted: false },
        select: { serviceCode: true, status: true },
      }),
    ]);
    const items = services.map((s) => {
      const own = menus.filter((m) => m.serviceCode === s.itemCode);
      const active = own.filter((m) => m.status === 'ACTIVE').length;
      return {
        serviceCode: s.itemCode,
        name: s.label,
        status: s.status,
        menuCount: own.length,
        activeMenuCount: active,
        inactiveMenuCount: own.length - active,
      };
    });
    return { items, total: items.length };
  }

  /** 서비스 하나의 메뉴 트리 — 페이지 없이 전부, 형제 순서대로. 없는 서비스는 404. */
  async tree(serviceCode: string): Promise<PlatformMenuTreeResponseDto> {
    const service = await findService(this.prisma, serviceCode);
    if (!service) throw new NotFoundException(SERVICE_NOT_FOUND);
    const menus = await this.prisma.menu.findMany({
      where: { serviceCode, isDeleted: false },
      select: MENU_SELECT,
    });
    const hidden = hiddenMenuIds(menus, service.status === 'ACTIVE');
    const build = (
      parentMenuId: number | null,
    ): PlatformMenuNodeResponseDto[] =>
      siblingsOf(menus, parentMenuId).map((row) => {
        const m = row as MenuRecord;
        const children = build(m.menuId);
        return {
          menuId: m.menuId,
          menuCode: m.menuCode,
          name: m.name,
          url: m.url,
          depth: m.depth,
          sortOrder: m.sortOrder,
          status: m.status,
          isGroup: children.length > 0,
          isHidden: hidden.has(m.menuId),
          children,
        };
      });
    return {
      service: {
        serviceCode: service.itemCode,
        name: service.label,
        status: service.status,
      },
      items: build(null),
      total: menus.length,
    };
  }

  /**
   * 상세 — 상위 · 경로 · 묶음 여부 · 숨김과 등록자 · 수정자. 없거나 지운 메뉴는 404. 메뉴의 서비스가 공통코드에 없으면
   * 데이터가 어긋난 것이라 500 — 서비스명을 코드로 채우고 모두 숨김으로 보이면 정상처럼 보여 원인이 묻힌다.
   */
  async detail(menuId: number): Promise<PlatformMenuDetailResponseDto> {
    const menu = await this.prisma.menu.findFirst({
      where: { menuId, isDeleted: false },
      select: {
        ...MENU_SELECT,
        createdAt: true,
        updatedAt: true,
        creator: ACTOR,
        updater: ACTOR,
      },
    });
    if (!menu) throw new NotFoundException(NOT_FOUND);
    const [service, menus] = await Promise.all([
      findService(this.prisma, menu.serviceCode),
      this.prisma.menu.findMany({
        where: { serviceCode: menu.serviceCode, isDeleted: false },
        select: MENU_SELECT,
      }),
    ]);
    if (!service)
      throw new InternalServerErrorException(
        `메뉴의 서비스(${menu.serviceCode})가 공통코드 SERVICE 에 없습니다`,
      );
    const byId = new Map(menus.map((m) => [m.menuId, m]));
    const path: string[] = [];
    const seen = new Set<number>();
    for (
      let cur: MenuRecord | undefined = byId.get(menuId) ?? menu;
      cur && !seen.has(cur.menuId);
      cur = cur.parentMenuId === null ? undefined : byId.get(cur.parentMenuId)
    ) {
      seen.add(cur.menuId);
      path.unshift(cur.name);
    }
    const parent =
      menu.parentMenuId === null ? undefined : byId.get(menu.parentMenuId);
    // 칸을 하나씩 적는다 — 펼치면 응답 스키마에 없는 parentMenuId 도 실려 나간다(상위는 parent 로만 준다).
    return {
      menuId: menu.menuId,
      menuCode: menu.menuCode,
      serviceCode: menu.serviceCode,
      name: menu.name,
      url: menu.url,
      sortOrder: menu.sortOrder,
      depth: menu.depth,
      status: menu.status,
      createdAt: menu.createdAt,
      updatedAt: menu.updatedAt,
      serviceName: service.label,
      parent: parent
        ? {
            menuId: parent.menuId,
            menuCode: parent.menuCode,
            name: parent.name,
          }
        : null,
      path,
      isGroup: menus.some((m) => m.parentMenuId === menuId),
      isHidden: hiddenMenuIds(menus, service.status === 'ACTIVE').has(menuId),
      createdBy: menu.creator,
      updatedBy: menu.updater,
    };
  }

  /**
   * 등록 — 고른 상위(없으면 최상위)의 맨 끝에. 메뉴 코드는 지운 메뉴까지 포함한 가장 큰 코드의 다음(서비스를 가리지
   * 않음). 사용중지 상위 아래에도 만든다. 플랫폼 마스터(PM000001)의 전체 권한 행을 같은 트랜잭션에서 넣는다 —
   * 권한 판정은 저장된 행을 읽어서, 없으면 플랫폼 마스터도 새 메뉴에서 403 이 된다. 다른 권한은 권한 관리에서 준다.
   */
  async create(
    callerId: number,
    dto: CreatePlatformMenuDto,
  ): Promise<CreatePlatformMenuResponseDto> {
    const by = callerId;
    const status = dto.status ?? UseStatus.ACTIVE;
    const url = dto.url ?? null;
    if (url && !MENU_URL_ONE_SEGMENT.test(url))
      throw new BadRequestException(MENU_URL_ONE_SEGMENT_MESSAGE);
    return this.write('등록', async (tx) => {
      await lockMenus(tx);
      if (!(await findService(tx, dto.serviceCode)))
        throw new BadRequestException(SERVICE_NOT_FOUND);
      const parentMenuId = dto.parentMenuId ?? null;
      const parent =
        parentMenuId === null
          ? null
          : await tx.menu.findFirst({
              where: { menuId: parentMenuId, isDeleted: false },
              select: MENU_SELECT,
            });
      if (parentMenuId !== null) {
        if (!parent)
          throw new BadRequestException('상위 메뉴로 고를 수 없는 메뉴입니다');
        if (parent.serviceCode !== dto.serviceCode)
          throw new BadRequestException(
            '같은 서비스의 메뉴만 상위로 고를 수 있습니다',
          );
        if (parent.depth >= MAX_MENU_DEPTH)
          throw new BadRequestException(TOO_DEEP);
      }
      if (status === UseStatus.ACTIVE && url) await assertUrlFree(tx, url);

      const last = await tx.menu.findFirst({
        orderBy: { menuCode: 'desc' },
        select: { menuCode: true },
      });
      const menuCode = nextMenuCode(last?.menuCode ?? null);
      const { _max } = await tx.menu.aggregate({
        where: parent
          ? { parentMenuId: parent.menuId, isDeleted: false }
          : {
              serviceCode: dto.serviceCode,
              parentMenuId: null,
              isDeleted: false,
            },
        _max: { sortOrder: true },
      });
      const master = await tx.roleGroup.findFirst({
        where: { roleCode: PLATFORM_MASTER_ROLE_CODE, isDeleted: false },
        select: { roleGroupId: true },
      });
      if (!master)
        throw new InternalServerErrorException(
          '플랫폼 마스터 권한(PM000001)이 없습니다 — 1팀 초기 데이터 마이그레이션을 확인해 주세요',
        );

      const created = await tx.menu.create({
        data: {
          menuCode,
          serviceCode: dto.serviceCode,
          parentMenuId,
          name: dto.name,
          url,
          sortOrder: (_max.sortOrder ?? 0) + 1,
          depth: parent ? parent.depth + 1 : 1,
          status,
          createdBy: by,
          updatedBy: by,
        },
        select: { menuId: true, menuCode: true },
      });
      await tx.roleGroupMenu.create({
        data: {
          roleGroupId: master.roleGroupId,
          menuId: created.menuId,
          isReadable: true,
          isCreatable: true,
          isUpdatable: true,
          isDeletable: true,
          createdBy: by,
          updatedBy: by,
        },
      });
      return created;
    });
  }

  /**
   * 노출 메뉴명 · URL · 사용 상태 수정 — 통째로 바꾼다(URL 을 빼면 비운다). 상세에서 받은 updatedAt 과 같은 ms 일 때만.
   * 미사용으로 저장하면 사용자 화면 · 신규 권한 부여에서 빠지고 하위도 함께 숨는다(하위의 상태 값은 그대로).
   * 이 화면 자신(MN000215)이나 권한 관리(MN000214)를 꺼도 막지 않는다(2026-10-16 결정). 메뉴 권한 판정은 그 메뉴 자신의
   * 상태만 보므로, MN000215 를 끄면 이 화면이 모두에게 403 이 되어 DB 로만 되돌린다. MN000214 를 끄면 권한 관리가
   * 403 이 되지만 여기서 다시 켤 수 있다.
   */
  async update(
    callerId: number,
    menuId: number,
    dto: UpdatePlatformMenuDto,
  ): Promise<void> {
    const url = dto.url ?? null;
    await this.write('수정', async (tx) => {
      await lockMenus(tx);
      const current = await findMenu(tx, menuId);
      // 바꾼 URL 만 1뎁스로 본다 — 그대로 둔 시드의 여러 구간 URL 로는 이름 · 상태를 고칠 수 있다
      if (url && url !== current.url && !MENU_URL_ONE_SEGMENT.test(url))
        throw new BadRequestException(MENU_URL_ONE_SEGMENT_MESSAGE);
      if (dto.status === UseStatus.ACTIVE && url)
        await assertUrlFree(tx, url, menuId);
      const { count } = await tx.menu.updateMany({
        where: {
          menuId,
          isDeleted: false,
          updatedAt: sameMillisecond(dto.updatedAt),
        },
        data: {
          name: dto.name,
          url,
          status: dto.status,
          updatedBy: callerId,
        },
      });
      if (count === 0) {
        // 그 사이 지워졌으면 404 — 다시 불러와도 없으니 409 로 안내하지 않는다.
        await findMenu(tx, menuId);
        throw new ConflictException(CHANGED_MEANWHILE);
      }
    });
  }

  /**
   * 위치 옮기기 — 같은 서비스 안에서만, 하위가 함께 간다. 옛 상위와 새 상위의 형제 순서를 1부터 다시 매기고 단계를
   * 다시 센다. 옮길 때마다 바로 저장되며 버전 확인은 하지 않는다(트리의 최신 상태 위에서 잠금 안에 계획한다).
   *
   * 위치는 수정 화면의 버전에 들지 않는다 — 바뀐 행의 updatedAt 을 원래 값으로 적어 @updatedAt 이 올리지 못하게 하고
   * 수정자도 덮지 않는다. 올리면 순서만 밀린 형제까지 버전이 바뀌어, 열어 둔 상세의 저장이 아무도 고치지 않았는데
   * 「다른 관리자가 먼저 수정했습니다」 409 가 된다. 그래서 수정자 · 수정일시는 메뉴명 · URL · 사용 상태의 마지막 수정이다.
   */
  async move(menuId: number, dto: MovePlatformMenuDto): Promise<void> {
    await this.write('옮기기', async (tx) => {
      await lockMenus(tx);
      const target = await findMenu(tx, menuId);
      const menus = await tx.menu.findMany({
        where: { serviceCode: target.serviceCode, isDeleted: false },
        select: { ...MENU_SELECT, updatedAt: true },
      });
      const updatedAt = new Map(menus.map((m) => [m.menuId, m.updatedAt]));
      for (const p of planMove(menus, menuId, dto.parentMenuId, dto.index))
        await tx.menu.update({
          where: { menuId: p.menuId },
          data: {
            parentMenuId: p.parentMenuId,
            sortOrder: p.sortOrder,
            depth: p.depth,
            updatedAt: updatedAt.get(p.menuId),
          },
        });
    });
  }

  /** 쓰기는 모두 한 잠금에 줄을 선다 — 몰려서 시간을 넘기면(P2028) 장애가 아니라 다시 시도할 일이라 503 이다. */
  private async write<T>(
    action: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(fn, MENU_WRITE_TX);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2028'
      ) {
        this.logger.error(`메뉴 ${action} 트랜잭션 시간 초과`, error.stack);
        throw new ServiceUnavailableException(
          '메뉴 저장이 몰렸습니다. 잠시 뒤 다시 시도해 주세요',
        );
      }
      throw error;
    }
  }
}

/** 메뉴 쓰기를 한 줄로 세운다 — 순서 · 채번 · URL 겹침이 모두 읽고 판단하고 쓰기라서. */
async function lockMenus(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('menus:write'))`;
}

/** 공통코드 SERVICE 의 값(사용중지 포함). */
function findService(db: Db, serviceCode: string) {
  return db.codeItem.findFirst({
    where: {
      groupCode: SERVICE_GROUP,
      itemCode: serviceCode,
      bpCode: PLATFORM_BP_CODE,
      isDeleted: false,
    },
    select: { itemCode: true, label: true, status: true },
  });
}

async function findMenu(db: Db, menuId: number): Promise<MenuRecord> {
  const menu = await db.menu.findFirst({
    where: { menuId, isDeleted: false },
    select: MENU_SELECT,
  });
  if (!menu) throw new NotFoundException(NOT_FOUND);
  return menu;
}

/**
 * 사용 중 메뉴끼리 URL 이 같거나 한쪽이 다른 쪽 아래 경로면 409 — 관리자 웹이 URL 접두어로 메뉴 권한을 가르므로,
 * 겹치면 위 메뉴의 권한만으로 아래 화면이 열린다. 서비스를 가리지 않고 본다(경로는 한 사이트의 것이다).
 */
async function assertUrlFree(
  tx: Tx,
  url: string,
  exceptMenuId?: number,
): Promise<void> {
  const active = await tx.menu.findMany({
    where: { isDeleted: false, status: UseStatus.ACTIVE, url: { not: null } },
    select: { menuId: true, menuCode: true, url: true },
  });
  const clash = active.find(
    (m) => m.menuId !== exceptMenuId && m.url && urlsOverlap(m.url, url),
  );
  if (clash)
    throw new ConflictException(
      `같거나 겹치는 URL 을 쓰는 사용 중 메뉴가 있습니다(${clash.menuCode})`,
    );
}
