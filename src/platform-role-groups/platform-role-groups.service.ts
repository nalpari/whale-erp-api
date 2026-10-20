import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isSameMillisecond, sameMillisecond } from '../common/updated-at';
import { MenuPermissionsService } from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreatePlatformRoleGroupResponseDto,
  PlatformRoleGroupDetailResponseDto,
  PlatformRoleGroupSummaryListResponseDto,
  PlatformRoleGroupSummaryResponseDto,
  RoleGroupDeletionCandidatesResponseDto,
} from './dto/platform-role-group.response.dto';
import type {
  CreatePlatformRoleGroupDto,
  DeletePlatformRoleGroupDto,
  UpdatePlatformRoleGroupDto,
} from './dto/save-platform-role-group.dto';
import {
  callerRoleMenuRights,
  findPlatformRoleGroup,
  isUniqueViolation,
  platformRoleGroupWhere,
  type Tx,
} from './platform-role-group-access';
import {
  ADDITIONAL_ROLE_TYPE,
  CHANGED_MEANWHILE,
  NAME_TAKEN,
  NOT_FOUND,
  nextRoleCode,
  type RoleGroupLockReason,
  roleGroupLabel,
  SELF_LINKED,
  sortPlatformRoleGroups,
} from './platform-role-group-format';

/** 채번은 한 줄로 선다 — 몰려도 기다리다 끝나게 넉넉히 둔다(점포 등록과 같다). */
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
  _count: {
    select: {
      // 메뉴 등록 여부 — 서비스와 관계없이 조회가 켜진 메뉴가 하나라도 있는가.
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

/**
 * 플랫폼 권한 관리(MN000214, S-JDCOAG) — 고정 권한(PM000001 · BM000001 · FM000001)과 플랫폼
 * 관리자 추가 권한(PA)의 목록 · 상세 · 등록 · 권한명 수정 · 삭제. 메뉴별 CRUD 는 PlatformRoleGroupMenusService 가
 * 맡는다. 메뉴 권한 · 플랫폼 계정 확인은 컨트롤러의 가드가 먼저 한다. 여기서는 받은 관리자 id 로 호출자를 읽어
 * 본인 연결 · 고정 권한 보호를 본다.
 */
@Injectable()
export class PlatformRoleGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: MenuPermissionsService,
  ) {}

  /** 목록. 페이지 없이 전부 — 고정 권한 다음 추가 권한을 코드 순으로. */
  async list(): Promise<PlatformRoleGroupSummaryListResponseDto> {
    const rows = await this.prisma.roleGroup.findMany({
      where: platformRoleGroupWhere(),
      select: SUMMARY_SELECT,
    });
    const items = sortPlatformRoleGroups(rows).map(summaryOf);
    return { items, total: items.length };
  }

  /** 상세. 권한명 · 설명을 고칠 수 있는지, 지울 수 있는지와 막힌 이유를 함께 준다. */
  async detail(
    callerId: number,
    roleGroupId: number,
  ): Promise<PlatformRoleGroupDetailResponseDto> {
    const caller = await this.permissions.caller(callerId);
    const row = await this.prisma.roleGroup.findFirst({
      where: platformRoleGroupWhere(roleGroupId),
      select: SUMMARY_SELECT,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const rights = await callerRoleMenuRights(this.prisma, caller.roleGroupId);
    const isSelf = caller.roleGroupId === roleGroupId;
    const editBlockedReason: RoleGroupLockReason | null = !rights.update
      ? 'NO_PERMISSION'
      : isSelf
        ? 'SELF_LINKED'
        : null;
    const deleteBlockedReason: RoleGroupLockReason | null = !isDeletableType(
      row,
    )
      ? 'FIXED_ROLE'
      : !rights.delete
        ? 'NO_PERMISSION'
        : isSelf
          ? 'SELF_LINKED'
          : null;
    return {
      ...summaryOf(row),
      isEditable: editBlockedReason === null,
      editBlockedReason,
      isDeletable: deleteBlockedReason === null,
      deleteBlockedReason,
    };
  }

  /**
   * 등록 — 플랫폼 관리자(PA) 추가 권한만. 권한 코드는 지운 그룹까지 포함한 마지막 PA 코드의 다음이고, 동시 등록이
   * 같은 번호를 집지 않게 advisory lock 으로 줄 세운다. 메뉴 권한은 비어 있다(「미등록」).
   */
  async create(
    callerId: number,
    dto: CreatePlatformRoleGroupDto,
  ): Promise<CreatePlatformRoleGroupResponseDto> {
    const caller = await this.permissions.caller(callerId);
    const bpCodeId = await this.platformBpId();
    await this.assertNameFree(bpCodeId, dto.name);
    const by = caller.adminAccountId;
    return this.prisma
      .$transaction(async (tx) => {
        // BP 쪽 권한 그룹 화면이 생기면 같은 키 이름 규칙(role_groups:role_code:{유형})으로 잠근다.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`role_groups:role_code:${ADDITIONAL_ROLE_TYPE}`}))`;
        const last = await tx.roleGroup.findFirst({
          where: { roleCode: { startsWith: ADDITIONAL_ROLE_TYPE } },
          orderBy: { roleCode: 'desc' },
          select: { roleCode: true },
        });
        const roleCode = nextRoleCode(
          ADDITIONAL_ROLE_TYPE,
          last?.roleCode ?? null,
        );
        return tx.roleGroup.create({
          data: {
            roleCode,
            bpCodeId,
            roleTypeCode: ADDITIONAL_ROLE_TYPE,
            name: dto.name,
            description: dto.description ?? null,
            isMaster: false,
            createdBy: by,
            updatedBy: by,
          },
          select: { roleGroupId: true, roleCode: true },
        });
      }, ROLE_CODE_TX)
      .catch((error) => this.rethrowNameConflict(error, bpCodeId, dto.name));
  }

  /** 권한명 · 설명 수정. 본인이 연결된 권한은 403. 상세에서 받은 updatedAt 과 같은 ms 일 때만 고친다. */
  async update(
    callerId: number,
    roleGroupId: number,
    dto: UpdatePlatformRoleGroupDto,
  ): Promise<void> {
    const caller = await this.permissions.caller(callerId);
    if (caller.roleGroupId === roleGroupId)
      throw new ForbiddenException(SELF_LINKED);
    const bpCodeId = await this.platformBpId();
    await this.assertNameFree(bpCodeId, dto.name, roleGroupId);
    await this.prisma
      .$transaction(async (tx) => {
        await findPlatformRoleGroup(tx, roleGroupId);
        const { count } = await tx.roleGroup.updateMany({
          where: {
            roleGroupId,
            isDeleted: false,
            updatedAt: sameMillisecond(dto.updatedAt),
          },
          data: {
            name: dto.name,
            description: dto.description ?? null,
            updatedBy: caller.adminAccountId,
          },
        });
        if (count === 0) {
          // 그 사이 지워졌으면 404 — 다시 불러와도 없으니 409 로 안내하지 않는다.
          await findPlatformRoleGroup(tx, roleGroupId);
          throw new ConflictException(CHANGED_MEANWHILE);
        }
      })
      .catch((error) =>
        this.rethrowNameConflict(error, bpCodeId, dto.name, roleGroupId),
      );
  }

  /** 삭제 대화상자 — 옮길 연결 사용자와 대체 권한 후보(같은 유형 PA 의 다른 추가 권한, 고정 권한 제외). */
  async deletionCandidates(
    roleGroupId: number,
  ): Promise<RoleGroupDeletionCandidatesResponseDto> {
    assertDeletable(await findPlatformRoleGroup(this.prisma, roleGroupId));
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
        where: candidateWhere(roleGroupId),
        select: { roleGroupId: true, roleCode: true, name: true },
        orderBy: { roleCode: 'asc' },
      }),
    ]);
    return { admins, candidates };
  }

  /**
   * 삭제 — 추가 권한만. 대상과 대체 행을 잠그고(FOR UPDATE) 연결 관리자를 대체 권한으로 옮긴 뒤 메뉴 행 · 그룹을
   * 지움 표시한다. 옮긴 관리자마다 관리자 변경 이력 「사용자 권한」을 남긴다. 다음 요청부터 새 권한으로 판정된다.
   *
   * 잠금은 동시 관리자 등록 · 수정을 막지 못한다 — 그쪽은 권한 그룹을 잠그지 않고 읽어 확인하므로, 이 삭제가
   * 커밋되기 전에 읽고 뒤에 쓴 요청은 지운 그룹(행은 남아 외래키가 통과한다)에 관리자를 붙일 수 있다. 그 관리자는
   * 모든 메뉴에서 403 이 된다. 막으려면 플랫폼 관리자 쪽이 그룹을 FOR SHARE 로 읽어야 한다.
   */
  async remove(
    callerId: number,
    roleGroupId: number,
    dto: DeletePlatformRoleGroupDto,
  ): Promise<void> {
    const caller = await this.permissions.caller(callerId);
    const by = caller.adminAccountId;
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
      const target = await findPlatformRoleGroup(tx, roleGroupId);
      assertDeletable(target);
      if (caller.roleGroupId === roleGroupId)
        throw new ForbiddenException(SELF_LINKED);
      if (!isSameMillisecond(target.updatedAt, dto.updatedAt))
        throw new ConflictException(CHANGED_MEANWHILE);

      const replacement =
        replacementId === undefined
          ? null
          : await this.findReplacement(tx, roleGroupId, replacementId);
      const admins = await tx.adminAccount.findMany({
        where: { roleGroupId, isDeleted: false },
        select: { adminAccountId: true },
      });
      if (admins.length && !replacement)
        throw new BadRequestException(
          '연결 사용자가 있어 대체 권한을 골라야 합니다',
        );

      if (admins.length && replacement) {
        // 읽은 관리자만 옮긴다 — 이력과 같은 집합이다. 그 사이 붙은 관리자는 위 주석의 경합이다.
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

  /** 대체 권한 — 같은 유형(PA)의 지우지 않은 다른 추가 권한. PA 고정 권한(is_master)이 생기면 옮기면 권한이 넓어져 뺀다. */
  private async findReplacement(
    tx: Tx,
    roleGroupId: number,
    replacementId: number,
  ) {
    if (replacementId === roleGroupId)
      throw new BadRequestException(
        '지우는 권한을 대체 권한으로 고를 수 없습니다',
      );
    const group = await tx.roleGroup.findFirst({
      where: {
        roleGroupId: replacementId,
        isDeleted: false,
        bpCode: { isPlatform: true },
      },
      select: {
        roleGroupId: true,
        roleCode: true,
        name: true,
        roleTypeCode: true,
        isMaster: true,
      },
    });
    if (!group || group.roleTypeCode !== ADDITIONAL_ROLE_TYPE)
      throw new BadRequestException('대체 권한으로 고를 수 없는 권한입니다');
    if (group.isMaster)
      throw new BadRequestException(
        `고정 권한 ${group.roleCode} 은 대체 권한으로 고를 수 없습니다`,
      );
    return group;
  }

  private async platformBpId(): Promise<number> {
    const bp = await this.prisma.bpCode.findFirst({
      where: { isPlatform: true },
      select: { bpCodeId: true },
    });
    if (!bp)
      throw new InternalServerErrorException(
        '플랫폼 BP(is_platform) 행이 없습니다 — 1팀 초기 데이터 마이그레이션을 확인해 주세요',
      );
    return bp.bpCodeId;
  }

  private async assertNameFree(
    bpCodeId: number,
    name: string,
    exceptRoleGroupId?: number,
  ): Promise<void> {
    if (await this.isNameTaken(bpCodeId, name, exceptRoleGroupId))
      throw new ConflictException(NAME_TAKEN);
  }

  /**
   * 쓰기가 고유 위반이면 이름 때문인지 다시 물어 409 로 바꾼다. 권한 코드 같은 다른 고유 위반은 그대로 던진다 —
   * 이름을 바꿔도 풀리지 않는 오류를 「같은 이름」으로 덮지 않게.
   */
  private async rethrowNameConflict(
    error: unknown,
    bpCodeId: number,
    name: string,
    exceptRoleGroupId?: number,
  ): Promise<never> {
    if (
      isUniqueViolation(error) &&
      (await this.isNameTaken(bpCodeId, name, exceptRoleGroupId))
    )
      throw new ConflictException(NAME_TAKEN);
    throw error;
  }

  /**
   * 권한명은 플랫폼 권한 안에서 고유하다 — DB 부분 고유 인덱스 (bp_code_id, manager_admin_account_id, name)
   * NULLS NOT DISTINCT WHERE NOT is_deleted 와 같은 범위다(플랫폼 그룹은 관리계정이 없다). 먼저 물어 409 를 주고,
   * 그 사이 끼어든 것은 인덱스가 막는다(rethrowNameConflict).
   */
  private async isNameTaken(
    bpCodeId: number,
    name: string,
    exceptRoleGroupId?: number,
  ): Promise<boolean> {
    const taken = await this.prisma.roleGroup.findFirst({
      where: {
        bpCodeId,
        managerAdminAccountId: null,
        name,
        isDeleted: false,
        ...(exceptRoleGroupId !== undefined && {
          roleGroupId: { not: exceptRoleGroupId },
        }),
      },
      select: { roleGroupId: true },
    });
    return taken !== null;
  }
}

type DeletableCheck = { isMaster: boolean; roleTypeCode: string };

function isDeletableType(group: DeletableCheck): boolean {
  return !group.isMaster && group.roleTypeCode === ADDITIONAL_ROLE_TYPE;
}

/** 지울 수 있는 것은 플랫폼 관리자(PA) 추가 권한뿐 — 고정 권한도, 잘못 들어간 다른 유형의 비고정 행도 409. */
function assertDeletable(target: DeletableCheck) {
  if (target.isMaster)
    throw new ConflictException('고정 권한은 삭제할 수 없습니다');
  if (target.roleTypeCode !== ADDITIONAL_ROLE_TYPE)
    throw new ConflictException('플랫폼 관리자 추가 권한만 삭제할 수 있습니다');
}

function candidateWhere(roleGroupId: number): Prisma.RoleGroupWhereInput {
  return {
    roleGroupId: { not: roleGroupId },
    isDeleted: false,
    isMaster: false,
    roleTypeCode: ADDITIONAL_ROLE_TYPE,
    bpCode: { isPlatform: true },
  };
}

function summaryOf(row: SummaryRow): PlatformRoleGroupSummaryResponseDto {
  const { _count, creator, updater, ...rest } = row;
  return {
    ...rest,
    isMenuRegistered: _count.menus > 0,
    createdBy: creator,
    updatedBy: updater,
    adminCount: _count.adminAccounts,
  };
}
