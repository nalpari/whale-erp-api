import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';
import { CodesService } from '../codes/codes.service';
import { sameMillisecond } from '../common/updated-at';
import type {
  RoleGroupMenuRevocationPreviewResponseDto,
  SaveRoleGroupMenusResponseDto,
} from '../platform-role-groups/dto/platform-role-group.response.dto';
import type {
  PreviewRoleGroupMenusDto,
  SaveRoleGroupMenusDto,
} from '../platform-role-groups/dto/save-platform-role-group.dto';
import {
  columnsOf,
  type Db,
  grantsOf,
} from '../platform-role-groups/platform-role-group-access';
import { CHANGED_MEANWHILE } from '../platform-role-groups/platform-role-group-format';
import {
  assertAllowed,
  type Catalog,
  idsOf,
  loadCatalog,
  menuTreeServices,
  planAfter,
  submittedCells,
} from '../platform-role-groups/platform-role-group-menus.service';
import {
  type CellFlags,
  changedCells,
  NO_FLAGS,
} from '../platform-role-groups/role-menu-rules';
import { PrismaService } from '../prisma/prisma.service';
import {
  BASE_ROLE_CODE,
  BP_ROLE_SERVICES,
  type BpRoleType,
  type BpScope,
  bpCellBlock,
  canWrite,
  findBpRoleGroup,
  intersectGrants,
} from './bp-role-group-access';
import { assertWritable } from './bp-role-groups.service';
import type { BpRoleGroupMenuTreeResponseDto } from './dto/bp-role-group.response.dto';

type Target = Awaited<ReturnType<typeof findBpRoleGroup>>;

/**
 * BP 권한 그룹의 메뉴 등록 팝업(S-KUDELB) — 메뉴 트리 · 저장 · 회수 미리보기 · 가맹마스터 보기. 트리는 WHALE_ERP
 * 서비스의 보이는 메뉴만이고, 칸의 상한은 기준 고정 권한(BA→BM000001, FA→FM000001)과 호출자 본인 권한의
 * 교집합이다. 판정 · 저장 검사는 플랫폼 메뉴 저장의 함수를 그대로 쓴다. BA · FA 는 하위 그룹이 없어 연쇄가 없다.
 */
@Injectable()
export class BpRoleGroupMenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodesService,
  ) {}

  async tree(
    scope: BpScope,
    roleGroupId: number,
  ): Promise<BpRoleGroupMenuTreeResponseDto> {
    const target = await findBpRoleGroup(this.prisma, scope, roleGroupId);
    const [catalog, grants, ceiling] = await Promise.all([
      this.catalog(),
      grantsOf(this.prisma, roleGroupId),
      this.ceilingOf(scope, target),
    ]);
    const writable = canWrite(scope, target);
    const isSelfLinked = scope.caller.roleGroupId === roleGroupId;
    const valueOf = (menuId: number) => grants.get(menuId) ?? NO_FLAGS;
    return {
      ...headerOf(target),
      isSavable: writable && !isSelfLinked,
      services: menuTreeServices(catalog, valueOf, (menu, op) =>
        bpCellBlock(
          {
            canWrite: writable,
            isSelfLinked,
            ceiling: ceiling.get(menu.menuId),
            current: valueOf(menu.menuId),
          },
          op,
        ),
      ),
    };
  }

  /** 메뉴 권한 저장 — 플랫폼 저장과 같이 updatedAt 을 먼저 올려 줄 세운 뒤 현재 값에서 바뀐 칸만 쓴다. */
  async save(
    scope: BpScope,
    roleGroupId: number,
    dto: SaveRoleGroupMenusDto,
  ): Promise<SaveRoleGroupMenusResponseDto> {
    const target = await findBpRoleGroup(this.prisma, scope, roleGroupId);
    assertWritable(scope, target);
    const catalog = await this.catalog();
    const submitted = submittedCells(dto.menus, catalog);
    const ceiling = await this.ceilingOf(scope, target);
    const by = scope.caller.adminAccountId;

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.roleGroup.updateMany({
        where: {
          roleGroupId,
          isDeleted: false,
          updatedAt: sameMillisecond(dto.updatedAt),
        },
        data: { updatedBy: by },
      });
      if (count === 0) {
        await findBpRoleGroup(tx, scope, roleGroupId);
        throw new ConflictException(CHANGED_MEANWHILE);
      }

      const { after, changes } = await planChanges(
        tx,
        roleGroupId,
        submitted,
        catalog,
      );
      assertAllowed(target, changes, catalog, ceiling);
      for (const menuId of new Set(changes.map((c) => c.menuId))) {
        const flags = columnsOf(after.get(menuId) ?? NO_FLAGS);
        await tx.roleGroupMenu.upsert({
          where: { roleGroupId_menuId: { roleGroupId, menuId } },
          create: {
            roleGroupId,
            menuId,
            ...flags,
            createdBy: by,
            updatedBy: by,
          },
          update: { ...flags, isDeleted: false, updatedBy: by },
        });
      }
      const { updatedAt } = await tx.roleGroup.findUniqueOrThrow({
        where: { roleGroupId },
        select: { updatedAt: true },
      });
      return { updatedAt };
    });
  }

  /**
   * 회수 미리보기 — 저장과 같은 400 검사(메뉴 · 조회 없는 쓰기 · 상한)만 하고 쓰지 않는다. 역할 · 본인 연결 · updatedAt 은
   * 보지 않는다(조회 권한으로 부른다). 하위 그룹이 없어 그룹 수는 늘 0, 관리자 수는 이 그룹의 것이다.
   */
  async preview(
    scope: BpScope,
    roleGroupId: number,
    dto: PreviewRoleGroupMenusDto,
  ): Promise<RoleGroupMenuRevocationPreviewResponseDto> {
    const target = await findBpRoleGroup(this.prisma, scope, roleGroupId);
    const catalog = await this.catalog();
    const submitted = submittedCells(dto.menus, catalog);
    const { changes } = await planChanges(
      this.prisma,
      roleGroupId,
      submitted,
      catalog,
    );
    assertAllowed(
      target,
      changes,
      catalog,
      await this.ceilingOf(scope, target),
    );
    const revokedCells = changes.filter((c) => c.from && !c.to).length;
    // 회수가 없으면 아무도 영향받지 않는다 — 플랫폼 미리보기와 같다.
    const affectedAdminCount =
      revokedCells === 0
        ? 0
        : await this.prisma.adminAccount.count({
            where: { roleGroupId, isDeleted: false },
          });
    return { revokedCells, affectedRoleGroupCount: 0, affectedAdminCount };
  }

  /** 가맹마스터 보기 — FM000001 트리, 모든 칸 읽기 전용. 가맹 관리자는 403. */
  async franchiseMasterTree(
    scope: BpScope,
  ): Promise<BpRoleGroupMenuTreeResponseDto> {
    if (scope.caller.roleTypeCode === 'FA')
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    const master = await findBaseRole(this.prisma, BASE_ROLE_CODE.FA);
    const [catalog, grants] = await Promise.all([
      this.catalog(),
      grantsOf(this.prisma, master.roleGroupId),
    ]);
    return {
      ...headerOf(master),
      isSavable: false,
      services: menuTreeServices(
        catalog,
        (menuId) => grants.get(menuId) ?? NO_FLAGS,
        () => 'READ_ONLY',
      ),
    };
  }

  private catalog(): Promise<Catalog> {
    return loadCatalog(this.prisma, this.codes, BP_ROLE_SERVICES);
  }

  /** 칸의 상한 — 기준 고정 권한 ∩ 호출자 본인 권한. */
  private async ceilingOf(
    scope: BpScope,
    target: Target,
  ): Promise<Map<number, CellFlags>> {
    const base = await findBaseRole(
      this.prisma,
      BASE_ROLE_CODE[target.roleTypeCode as BpRoleType],
    );
    const [baseGrants, callerGrants] = await Promise.all([
      grantsOf(this.prisma, base.roleGroupId),
      grantsOf(this.prisma, scope.caller.roleGroupId),
    ]);
    return intersectGrants(baseGrants, callerGrants);
  }
}

const logger = new Logger('BpRoleGroupMenusService');

/** 기준 고정 권한(마이그레이션 시드). 없으면 데이터 오류다. */
async function findBaseRole(db: Db, roleCode: string) {
  const group = await db.roleGroup.findFirst({
    where: { roleCode, isMaster: true, isDeleted: false },
    select: {
      roleGroupId: true,
      roleCode: true,
      roleTypeCode: true,
      name: true,
      updatedAt: true,
    },
  });
  if (!group) {
    // 응답만으로는 운영자가 모른다 — 전역 예외 필터가 없어 HttpException 은 로그에 남지 않는다.
    const message = `고정 권한 ${roleCode} 이 없습니다 — 1팀 초기 데이터 마이그레이션을 확인해 주세요.`;
    logger.error(message);
    throw new InternalServerErrorException(message);
  }
  return group;
}

/** 현재 값 위에 보낸 칸을 얹은 결과와 바뀐 칸. */
async function planChanges(
  db: Db,
  roleGroupId: number,
  submitted: Map<number, CellFlags>,
  catalog: Catalog,
) {
  const before = await grantsOf(db, roleGroupId);
  const after = planAfter(before, submitted, catalog.visible);
  return {
    after,
    changes: changedCells(before, after, idsOf(catalog.visible)),
  };
}

function headerOf(group: {
  roleGroupId: number;
  roleCode: string;
  roleTypeCode: string;
  name: string;
  updatedAt: Date;
}) {
  return {
    roleGroupId: group.roleGroupId,
    roleCode: group.roleCode,
    roleTypeCode: group.roleTypeCode,
    name: group.name,
    updatedAt: group.updatedAt,
  };
}
