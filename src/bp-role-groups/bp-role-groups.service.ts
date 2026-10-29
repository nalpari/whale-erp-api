import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ACCESS_DENIED_MESSAGE } from '../auth/access-messages';
import { isSameMillisecond, sameMillisecond } from '../common/updated-at';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import type { PageDto } from '../platform-admins/dto/list-platform-admins.dto';
import type {
  CreatePlatformRoleGroupResponseDto,
  RoleGroupDeletionCandidatesResponseDto,
} from '../platform-role-groups/dto/platform-role-group.response.dto';
import type {
  CreatePlatformRoleGroupDto,
  DeletePlatformRoleGroupDto,
  UpdatePlatformRoleGroupDto,
} from '../platform-role-groups/dto/save-platform-role-group.dto';
import {
  isUniqueViolation,
  type Tx,
} from '../platform-role-groups/platform-role-group-access';
import {
  CHANGED_MEANWHILE,
  NAME_TAKEN,
  NOT_FOUND,
  nextRoleCode,
  type RoleGroupLockReason,
  roleGroupLabel,
  SELF_LINKED,
} from '../platform-role-groups/platform-role-group-format';
import { PrismaService } from '../prisma/prisma.service';
import {
  type BpScope,
  canWrite,
  findBpRoleGroup,
  resolveScope,
  visibleWhere,
} from './bp-role-group-access';
import type {
  BpRoleGroupDetailResponseDto,
  BpRoleGroupListResponseDto,
  BpRoleGroupSummaryResponseDto,
} from './dto/bp-role-group.response.dto';

/** 채번은 한 줄로 선다 — 플랫폼 권한 등록과 같다. */
const ROLE_CODE_TX = { maxWait: 5_000, timeout: 15_000 };

const ACTOR = { select: { name: true, loginId: true } } as const;
const SUMMARY_SELECT = {
  roleGroupId: true,
  roleCode: true,
  roleTypeCode: true,
  name: true,
  description: true,
  isMaster: true,
  createdAt: true,
  updatedAt: true,
  creator: ACTOR,
  updater: ACTOR,
  manager: { select: { adminAccountId: true, loginId: true, name: true } },
  _count: {
    select: {
      menus: {
        where: {
          isDeleted: false,
          isReadable: true,
          menu: { isDeleted: false },
        },
      },
      adminAccounts: { where: { isDeleted: false } },
    },
  },
} satisfies Prisma.RoleGroupSelect;
type SummaryRow = Prisma.RoleGroupGetPayload<{ select: typeof SUMMARY_SELECT }>;

type Target = Awaited<ReturnType<typeof findBpRoleGroup>>;

/**
 * BP 권한 그룹 관리(MN000013, S-LYKAEI) — BP 관리자(BA) · 가맹 관리자(FA) 그룹의 목록 · 상세 · 등록 · 수정 · 삭제.
 * 메뉴 권한 · 대상 BP 는 가드(`@MenuPermission`)가 먼저 정한다. 여기서는 역할 범위(BpScope) · 본인 연결 · 동시 수정을 본다.
 */
@Injectable()
export class BpRoleGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: MenuPermissionsService,
  ) {}

  /** 가드를 통과한 호출자의 범위. 계정이 그 사이 사용중지 · 탈퇴 · 삭제됐으면 403. */
  async scopeOf(callerId: number, bp: TargetBpContext): Promise<BpScope> {
    const caller = await this.permissions.caller(callerId);
    return resolveScope(this.prisma, caller, bp);
  }

  /** 목록 — 권한 코드 순(BA 다음 FA) + id, 쪽 나눔. */
  async list(
    scope: BpScope,
    { page, pageSize }: Pick<PageDto, 'page' | 'pageSize'>,
  ): Promise<BpRoleGroupListResponseDto> {
    const where = visibleWhere(scope);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.roleGroup.findMany({
        where,
        select: SUMMARY_SELECT,
        orderBy: [{ roleCode: 'asc' }, { roleGroupId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.roleGroup.count({ where }),
    ]);
    return {
      items: rows.map((row) => summaryOf(row, scope)),
      total,
      creatableRoleTypeCode: scope.writableType,
    };
  }

  /** 상세 — 역할로 고칠 수 있는지 · 지울 수 있는지와 막힌 이유. 메뉴 권한은 화면이 합친다. */
  async detail(
    scope: BpScope,
    roleGroupId: number,
  ): Promise<BpRoleGroupDetailResponseDto> {
    const row = await this.prisma.roleGroup.findFirst({
      where: visibleWhere(scope, roleGroupId),
      select: SUMMARY_SELECT,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const lock: RoleGroupLockReason | null = !canWrite(scope, row)
      ? 'NO_PERMISSION'
      : scope.caller.roleGroupId === roleGroupId
        ? 'SELF_LINKED'
        : null;
    return {
      ...summaryOf(row, scope),
      isEditable: lock === null,
      editBlockedReason: lock,
      isDeletable: lock === null,
      deleteBlockedReason: lock,
    };
  }

  /**
   * 등록 — BM 은 BA(관리계정 없음), FM 은 FA(관리계정 = 본인). 권한 코드는 지운 그룹까지 포함한 그 유형의 마지막
   * 코드 다음이고, 플랫폼 권한 등록과 같은 키 규칙(role_groups:role_code:{유형})으로 잠가 줄 세운다.
   */
  async create(
    scope: BpScope,
    dto: CreatePlatformRoleGroupDto,
  ): Promise<CreatePlatformRoleGroupResponseDto> {
    const roleType = scope.writableType;
    if (!roleType) throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    // 쓸 수 있는 범위의 관리계정 — FM 은 본인, BM 은 null(BA).
    const managerId = scope.managerId;
    const key = { bpCodeId: scope.bpCodeId, managerId, name: dto.name };
    await this.assertNameFree(key);
    const by = scope.caller.adminAccountId;
    return this.prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`role_groups:role_code:${roleType}`}))`;
        const last = await tx.roleGroup.findFirst({
          where: { roleCode: { startsWith: roleType } },
          orderBy: { roleCode: 'desc' },
          select: { roleCode: true },
        });
        return tx.roleGroup.create({
          data: {
            roleCode: nextRoleCode(roleType, last?.roleCode ?? null),
            bpCodeId: scope.bpCodeId,
            roleTypeCode: roleType,
            name: dto.name,
            description: dto.description ?? null,
            isMaster: false,
            managerAdminAccountId: managerId,
            createdBy: by,
            updatedBy: by,
          },
          select: { roleGroupId: true, roleCode: true },
        });
      }, ROLE_CODE_TX)
      .catch((error) => this.rethrowNameConflict(error, key));
  }

  /** 권한명 · 설명 수정. 역할로 못 고치면 403, 본인 연결이면 403, 상세의 updatedAt 과 다르면 409. */
  async update(
    scope: BpScope,
    roleGroupId: number,
    dto: UpdatePlatformRoleGroupDto,
  ): Promise<void> {
    const target = await findBpRoleGroup(this.prisma, scope, roleGroupId);
    assertWritable(scope, target);
    const key = {
      bpCodeId: scope.bpCodeId,
      managerId: target.managerAdminAccountId,
      name: dto.name,
      exceptRoleGroupId: roleGroupId,
    };
    await this.assertNameFree(key);
    await this.prisma
      .$transaction(async (tx) => {
        const { count } = await tx.roleGroup.updateMany({
          where: {
            roleGroupId,
            isDeleted: false,
            updatedAt: sameMillisecond(dto.updatedAt),
          },
          data: {
            name: dto.name,
            description: dto.description ?? null,
            updatedBy: scope.caller.adminAccountId,
          },
        });
        if (count === 0) {
          // 그 사이 지워졌으면 404 — 다시 불러와도 없으니 409 로 안내하지 않는다.
          await findBpRoleGroup(tx, scope, roleGroupId);
          throw new ConflictException(CHANGED_MEANWHILE);
        }
      })
      .catch((error) => this.rethrowNameConflict(error, key));
  }

  /** 삭제 대화상자 — 옮길 연결 사용자와 대체 후보(같은 BP · 유형 · 관리계정의 다른 그룹). 조회 권한이면 된다. */
  async deletionCandidates(
    scope: BpScope,
    roleGroupId: number,
  ): Promise<RoleGroupDeletionCandidatesResponseDto> {
    const target = await findBpRoleGroup(this.prisma, scope, roleGroupId);
    const [admins, candidates] = await Promise.all([
      this.prisma.adminAccount.findMany({
        where: { roleGroupId, isDeleted: false },
        select: {
          adminAccountId: true,
          loginId: true,
          name: true,
          accountStatusCode: true,
        },
        orderBy: { adminAccountId: 'asc' },
      }),
      this.prisma.roleGroup.findMany({
        where: candidateWhere(scope, target),
        select: { roleGroupId: true, roleCode: true, name: true },
        orderBy: { roleCode: 'asc' },
      }),
    ]);
    return { admins, candidates };
  }

  /**
   * 삭제 — 대상과 대체 행을 잠그고(FOR UPDATE) 연결 관리자를 대체 그룹으로 옮긴 뒤 메뉴 행 · 그룹을 지움 표시한다.
   * 옮긴 관리자마다 관리자 변경 이력 「사용자 권한」을 남긴다. 동시 관리자 등록과의 경합은 플랫폼 삭제와 같다.
   */
  async remove(
    scope: BpScope,
    roleGroupId: number,
    dto: DeletePlatformRoleGroupDto,
  ): Promise<void> {
    const by = scope.caller.adminAccountId;
    const replacementId = dto.replacementRoleGroupId;
    await this.prisma.$transaction(async (tx) => {
      const ids = [roleGroupId, replacementId]
        .filter((id): id is number => id !== undefined)
        .sort((a, b) => a - b);
      await tx.$queryRaw`
        SELECT role_group_id FROM role_groups
         WHERE role_group_id IN (${Prisma.join(ids)})
         ORDER BY role_group_id
           FOR UPDATE`;
      const target = await findBpRoleGroup(tx, scope, roleGroupId);
      assertWritable(scope, target);
      if (!isSameMillisecond(target.updatedAt, dto.updatedAt))
        throw new ConflictException(CHANGED_MEANWHILE);

      const replacement =
        replacementId === undefined
          ? null
          : await findReplacement(tx, scope, target, replacementId);
      const admins = await tx.adminAccount.findMany({
        where: { roleGroupId, isDeleted: false },
        select: { adminAccountId: true },
      });
      if (admins.length && !replacement)
        throw new BadRequestException(
          '연결 사용자가 있어 대체 권한을 골라야 합니다.',
        );

      if (admins.length && replacement) {
        await tx.adminAccount.updateMany({
          where: {
            adminAccountId: { in: admins.map((a) => a.adminAccountId) },
            isDeleted: false,
          },
          data: { roleGroupId: replacement.roleGroupId, updatedBy: by },
        });
        await tx.adminChangeHistory.createMany({
          data: admins.map(({ adminAccountId }) => ({
            adminAccountId,
            field: '사용자 권한',
            beforeValue: roleGroupLabel(target),
            afterValue: roleGroupLabel(replacement),
            changedBy: by,
          })),
        });
      }
      await tx.roleGroupMenu.updateMany({
        where: { roleGroupId, isDeleted: false },
        data: { isDeleted: true, updatedBy: by },
      });
      await tx.roleGroup.update({
        where: { roleGroupId },
        data: { isDeleted: true, updatedBy: by },
      });
    });
  }

  private async assertNameFree(key: NameKey): Promise<void> {
    if (await this.isNameTaken(key)) throw new ConflictException(NAME_TAKEN);
  }

  /** 고유 위반이 이름 때문이면 409 로 바꾼다. 권한 코드 같은 다른 위반은 그대로 던진다. */
  private async rethrowNameConflict(
    error: unknown,
    key: NameKey,
  ): Promise<never> {
    // 다시 읽기가 실패하면 원래 고유 위반을 던진다 — 연결 오류가 원인을 덮지 않게.
    if (
      isUniqueViolation(error) &&
      (await this.isNameTaken(key).catch(() => false))
    )
      throw new ConflictException(NAME_TAKEN);
    throw error;
  }

  /**
   * 권한명은 같은 BP · 같은 관리계정 안에서 고유하다 — DB 부분 고유 인덱스 (bp_code_id, manager_admin_account_id,
   * name) NULLS NOT DISTINCT WHERE NOT is_deleted 와 같은 범위다. BA 는 관리계정이 없고 FA 는 가맹 마스터라, BA 끼리 ·
   * 가맹 마스터별 FA 끼리 따로 본다.
   */
  private async isNameTaken(key: NameKey): Promise<boolean> {
    const taken = await this.prisma.roleGroup.findFirst({
      where: {
        bpCodeId: key.bpCodeId,
        managerAdminAccountId: key.managerId,
        name: key.name,
        isDeleted: false,
        ...(key.exceptRoleGroupId !== undefined && {
          roleGroupId: { not: key.exceptRoleGroupId },
        }),
      },
      select: { roleGroupId: true },
    });
    return taken !== null;
  }
}

type NameKey = {
  bpCodeId: number;
  managerId: number | null;
  name: string;
  exceptRoleGroupId?: number;
};

/** 역할로 쓸 수 없으면 403, 본인 연결이면 403. */
export function assertWritable(scope: BpScope, target: Target): void {
  if (!canWrite(scope, target))
    throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
  if (scope.caller.roleGroupId === target.roleGroupId)
    throw new ForbiddenException(SELF_LINKED);
}

/** 대체 후보 — 같은 BP · 같은 유형 · 같은 관리계정의 지우지 않은 다른 비고정 그룹. 옮겨도 권한 범위가 같다. */
function candidateWhere(
  scope: BpScope,
  target: Target,
): Prisma.RoleGroupWhereInput {
  return {
    roleGroupId: { not: target.roleGroupId },
    bpCodeId: scope.bpCodeId,
    roleTypeCode: target.roleTypeCode,
    managerAdminAccountId: target.managerAdminAccountId,
    isDeleted: false,
    isMaster: false,
  };
}

async function findReplacement(
  tx: Tx,
  scope: BpScope,
  target: Target,
  replacementId: number,
) {
  if (replacementId === target.roleGroupId)
    throw new BadRequestException(
      '지우는 권한을 대체 권한으로 고를 수 없습니다.',
    );
  const group = await tx.roleGroup.findFirst({
    where: { ...candidateWhere(scope, target), roleGroupId: replacementId },
    select: { roleGroupId: true, roleCode: true, name: true },
  });
  if (!group)
    throw new BadRequestException('대체 권한으로 고를 수 없는 권한입니다.');
  return group;
}

function summaryOf(
  row: SummaryRow,
  scope: BpScope,
): BpRoleGroupSummaryResponseDto {
  const { _count, creator, updater, ...rest } = row;
  return {
    ...rest,
    isMenuRegistered: _count.menus > 0,
    menuCount: _count.menus,
    createdBy: creator,
    updatedBy: updater,
    adminCount: _count.adminAccounts,
    isSelfLinked: row.roleGroupId === scope.caller.roleGroupId,
  };
}
