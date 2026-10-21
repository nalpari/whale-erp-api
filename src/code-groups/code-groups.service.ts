import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  BP_ONLY_OWNER_CODE,
  PLATFORM_BP_CODE,
  PLATFORM_OWNER_CODES,
} from './code-format';
import type {
  BpApplicationResponseDto,
  CodeGroupListResponseDto,
  CodeItemListResponseDto,
} from './dto/code-group.response.dto';
import type { ListCodeGroupsDto } from './dto/list-code-groups.dto';
import type { CodeGroupInputDto } from './dto/code-group-input.dto';
import type { CodeItemInputDto } from './dto/code-item-input.dto';
import type { CreateCodeGroupDto } from './dto/create-code-groups.dto';

const PLATFORM_PROVIDED = 'PLATFORM_PROVIDED';
const GROUP_NOT_FOUND = '공통코드 그룹을 찾을 수 없습니다';

const groupSelect = {
  groupCode: true,
  groupName: true,
  manageOwnerCode: true,
  isBpApplied: true,
  status: true,
  sortOrder: true,
} as const;
const itemSelect = {
  itemCode: true,
  label: true,
  status: true,
  sortOrder: true,
} as const;

/**
 * 플랫폼 공통코드 관리 (S-UQPNIH · F-LOUVWE). 플랫폼고정 · 플랫폼제공 그룹과 그 플랫폼 원본(BP000000)
 * 상세 코드만 다룬다. BP 가 추가한 BP전용 상세 코드는 보이지도 고쳐지지도 않는다(PL-VOCZCE).
 *
 * 코드 · 관리 주체는 등록 뒤 바꾸지 않는다 — 수정 요청은 이름 · 사용 상태 · 표시 순서만 쓴다.
 * 물리 삭제는 없다. 등록 · 수정 이력은 아직 쓰지 않는다(이력 테이블이 생기면 여기서 남긴다).
 */
@Injectable()
export class CodeGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async listGroups({
    page,
    pageSize,
  }: ListCodeGroupsDto): Promise<CodeGroupListResponseDto> {
    const where = {
      isDeleted: false,
      manageOwnerCode: { in: [...PLATFORM_OWNER_CODES] },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.codeGroup.findMany({
        where,
        select: groupSelect,
        orderBy: [{ sortOrder: 'asc' }, { groupCode: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.codeGroup.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * 그룹 등록. 지운 그룹의 코드도 다시 쓰지 않는다. 확인과 INSERT 가 한 트랜잭션이다 — 한 행이라도 막히면
   * 아무것도 생기지 않는다.
   */
  async createGroups(
    callerId: number,
    items: CreateCodeGroupDto[],
  ): Promise<void> {
    assertNoRepeat(
      items.map((c) => c.groupCode),
      '이미 있는 그룹 코드입니다',
    );
    await this.prisma.$transaction(async (tx) => {
      // 지운 그룹도 함께 읽는다 — 지운 그룹의 코드도 다시 쓰지 않는다.
      const found = await tx.codeGroup.findMany({
        where: { groupCode: { in: items.map((g) => g.groupCode) } },
        select: { groupCode: true },
      });
      const takenCodes = new Set(found.map((g) => g.groupCode));
      const taken = items.find((c) => takenCodes.has(c.groupCode));
      if (taken)
        throw new ConflictException(
          `이미 있는 그룹 코드입니다: ${taken.groupCode}`,
        );

      // 위 확인과 INSERT 사이에 다른 관리자가 같은 코드를 넣으면 키가 겹친다. 건너뛰고 409 로 되돌린다 —
      // 그대로 두면 키 위반이 500 으로 나간다. 이번 INSERT 가 만든 행을 돌려받아 만들지 못한 코드(먼저
      // 들어간 것)만 알린다. 뒤에 다시 읽으면 이번 트랜잭션이 넣은 행과 구분할 수 없다.
      const created = await tx.codeGroup.createManyAndReturn({
        data: items.map((c) => ({
          groupCode: c.groupCode,
          groupName: c.groupName,
          manageOwnerCode: c.manageOwnerCode,
          status: c.status,
          sortOrder: c.sortOrder,
          isBpApplied: false,
          createdBy: callerId,
          updatedBy: callerId,
        })),
        select: { groupCode: true },
        skipDuplicates: true,
      });
      const lost = notCreated(
        items.map((c) => c.groupCode),
        created.map((c) => c.groupCode),
      );
      if (lost.length)
        throw new ConflictException(
          `이미 있는 그룹 코드입니다: ${lost.join(', ')}`,
        );
    });
  }

  /**
   * 그룹 수정. 지우지 않은 플랫폼고정 · 플랫폼제공 그룹만, 그룹명 · 사용 상태 · 표시 순서만 고친다.
   * 한 행이라도 없으면 아무것도 고치지 않는다(한 트랜잭션). 같은 그룹 코드가 두 번 오면 어느 값을 남길지
   * 정할 수 없으므로 DB 에 묻기 전에 409.
   */
  async updateGroups(
    callerId: number,
    items: CodeGroupInputDto[],
  ): Promise<void> {
    assertNoRepeat(
      items.map((g) => g.groupCode),
      '한 요청에 같은 그룹 코드가 두 번 있습니다',
    );
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.codeGroup.findMany({
        where: { groupCode: { in: items.map((g) => g.groupCode) } },
        select: { groupCode: true, manageOwnerCode: true, isDeleted: true },
      });
      const byCode = new Map(found.map((g) => [g.groupCode, g]));
      for (const { groupCode } of items) {
        const g = byCode.get(groupCode);
        if (!g || g.isDeleted || !isPlatformOwner(g.manageOwnerCode))
          throw new NotFoundException(`${GROUP_NOT_FOUND}: ${groupCode}`);
      }

      for (const { groupCode, groupName, status, sortOrder } of items)
        await tx.codeGroup.update({
          where: { groupCode },
          data: { groupName, status, sortOrder, updatedBy: callerId },
        });
    });
  }

  async listItems(groupCode: string): Promise<CodeItemListResponseDto> {
    await this.findPlatformGroup(groupCode);
    const where = {
      groupCode,
      bpCode: PLATFORM_BP_CODE,
      isDeleted: false,
      manageOwnerCode: { not: BP_ONLY_OWNER_CODE },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.codeItem.findMany({
        where,
        select: itemSelect,
        orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
      }),
      this.prisma.codeItem.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * 상세 코드 등록. 플랫폼 원본(BP000000)에 소속 그룹의 관리 주체로 만든다. 확인과 INSERT 가 한
   * 트랜잭션이다 — 한 행이라도 막히면 아무것도 생기지 않는다.
   */
  async createItems(
    callerId: number,
    groupCode: string,
    items: CodeItemInputDto[],
  ): Promise<void> {
    const group = await this.findPlatformGroup(groupCode);
    assertNoRepeat(
      items.map((c) => c.itemCode),
      '이 그룹에 이미 있는 상세 코드입니다',
    );
    await this.prisma.$transaction(async (tx) => {
      // 같은 그룹 안에서는 BP별 행 · BP전용 코드 · 지운 코드와도 겹칠 수 없다.
      // 겹치면 BP에 적용할 때 BP 행과 같은 키가 된다.
      const taken = await tx.codeItem.findMany({
        where: { groupCode, itemCode: { in: items.map((c) => c.itemCode) } },
        select: { itemCode: true },
        take: 1,
      });
      if (taken.length)
        throw new ConflictException(
          `이 그룹에 이미 있는 상세 코드입니다: ${taken[0].itemCode}`,
        );

      // 그룹 등록과 같다 — 확인 뒤 끼어든 같은 코드는 500 이 아니라 409, 메시지에는 겹친 코드만.
      const created = await tx.codeItem.createManyAndReturn({
        data: items.map((c) => ({
          itemCode: c.itemCode,
          label: c.label,
          status: c.status,
          sortOrder: c.sortOrder,
          groupCode,
          bpCode: PLATFORM_BP_CODE,
          manageOwnerCode: group.manageOwnerCode,
          createdBy: callerId,
          updatedBy: callerId,
        })),
        select: { itemCode: true },
        skipDuplicates: true,
      });
      const lost = notCreated(
        items.map((c) => c.itemCode),
        created.map((c) => c.itemCode),
      );
      if (lost.length)
        throw new ConflictException(
          `이 그룹에 이미 있는 상세 코드입니다: ${lost.join(', ')}`,
        );
    });
  }

  /**
   * 상세 코드 수정. 이 그룹의 플랫폼 원본(BP전용 · 지운 행 제외)만, 코드명 · 사용 상태 · 표시 순서만 고친다.
   * 한 행이라도 없으면 아무것도 고치지 않는다(한 트랜잭션). 같은 코드가 두 번 오면 DB 에 묻기 전에 409.
   */
  async updateItems(
    callerId: number,
    groupCode: string,
    items: CodeItemInputDto[],
  ): Promise<void> {
    await this.findPlatformGroup(groupCode);
    assertNoRepeat(
      items.map((u) => u.itemCode),
      '한 요청에 같은 상세 코드가 두 번 있습니다',
    );
    await this.prisma.$transaction(async (tx) => {
      const editable = await tx.codeItem.findMany({
        where: {
          groupCode,
          bpCode: PLATFORM_BP_CODE,
          isDeleted: false,
          manageOwnerCode: { not: BP_ONLY_OWNER_CODE },
          itemCode: { in: items.map((u) => u.itemCode) },
        },
        select: { itemCode: true },
      });
      const editableCodes = new Set(editable.map((i) => i.itemCode));
      const missing = items.find((u) => !editableCodes.has(u.itemCode));
      if (missing)
        throw new NotFoundException(
          `상세 코드를 찾을 수 없습니다: ${missing.itemCode}`,
        );

      for (const { itemCode, label, status, sortOrder } of items)
        await tx.codeItem.update({
          where: {
            groupCode_itemCode_bpCode: {
              groupCode,
              itemCode,
              bpCode: PLATFORM_BP_CODE,
            },
          },
          data: { label, status, sortOrder, updatedBy: callerId },
        });
    });
  }

  /**
   * BP에 적용. 플랫폼제공 그룹의 플랫폼 원본을 사용 중인 모든 고객 BP 에 BP별 행으로 복사한다.
   * 각 BP 에 아직 없는 행만 넣는다 — 이미 있는 행(앞서 복사해 BP 가 고쳤거나 지운 행 · BP전용 행)은
   * 건너뛰며 덮어쓰거나 되살리지 않는다. 대상 BP 는 매번 다시 고르므로, 다시 적용하면 기존 BP 에는 그 뒤
   * 추가한 상세 코드가, 그 사이 사용 중이 된 BP 에는 전부가 들어간다. 원본을 고친 내용은 이미 있는 BP 행에
   * 반영되지 않는다. 적용 → 미적용은 없으므로, 넣을 BP 나 상세 코드가 없으면 적용으로 표시하지 않고 409.
   */
  async applyToBps(
    callerId: number,
    groupCode: string,
  ): Promise<BpApplicationResponseDto> {
    const group = await this.findPlatformGroup(groupCode);
    if (group.manageOwnerCode !== PLATFORM_PROVIDED)
      throw new ConflictException('플랫폼제공 그룹만 BP에 적용할 수 있습니다');

    return this.prisma.$transaction(
      async (tx) => {
        const originals = await tx.codeItem.findMany({
          where: {
            groupCode,
            bpCode: PLATFORM_BP_CODE,
            isDeleted: false,
            manageOwnerCode: { not: BP_ONLY_OWNER_CODE },
          },
          select: itemSelect,
          orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
        });
        const bps = await tx.bpCode.findMany({
          where: {
            isPlatform: false,
            isDeleted: false,
            accountStatusCode: 'ACTIVE',
          },
          select: { bpCode: true },
          orderBy: { bpCode: 'asc' },
        });
        const bpCodes = bps.map((b) => b.bpCode);
        if (!originals.length)
          throw new ConflictException(
            '상세 코드가 없는 그룹은 BP에 적용할 수 없습니다',
          );
        if (!bpCodes.length)
          throw new ConflictException('적용할 사용 중인 고객 BP 가 없습니다');

        // 키(그룹 · 상세 코드 · BP)가 이미 있는 행은 skipDuplicates 가 건너뛴다 — 덮어쓰지 않는다.
        // 그 테이블의 고유 제약은 PK 뿐이라 다른 위반이 조용히 건너뛰어지지는 않는다. 고유 제약을 더하면 다시 볼 것.
        const created = await tx.codeItem.createMany({
          data: bpCodes.flatMap((bpCode) =>
            originals.map((o) => ({
              groupCode,
              bpCode,
              itemCode: o.itemCode,
              label: o.label,
              status: o.status,
              sortOrder: o.sortOrder,
              manageOwnerCode: PLATFORM_PROVIDED,
              createdBy: callerId,
              updatedBy: callerId,
            })),
          ),
          skipDuplicates: true,
        });
        await tx.codeGroup.update({
          where: { groupCode },
          data: { isBpApplied: true, updatedBy: callerId },
        });
        return {
          bpCount: bpCodes.length,
          itemCount: originals.length,
          createdCount: created.count,
        };
      },
      // 넣는 행이 사용 중 BP 수 × 상세 코드 수라 BP 가 늘면 기본 5초를 넘긴다. batch-lock 과 같은 값.
      { timeout: 60_000, maxWait: 5_000 },
    );
  }

  /** 이 화면이 다루는 그룹(지우지 않은 플랫폼고정 · 플랫폼제공). 아니면 404. */
  private async findPlatformGroup(groupCode: string) {
    const group = await this.prisma.codeGroup.findFirst({
      where: {
        groupCode,
        isDeleted: false,
        manageOwnerCode: { in: [...PLATFORM_OWNER_CODES] },
      },
      select: { groupCode: true, manageOwnerCode: true },
    });
    if (!group) throw new NotFoundException(GROUP_NOT_FOUND);
    return group;
  }
}

function isPlatformOwner(code: string): boolean {
  return (PLATFORM_OWNER_CODES as readonly string[]).includes(code);
}

/** 한 요청 안에서 같은 코드가 두 번 오면(등록 · 수정 모두) DB 에 묻기 전에 409. */
function assertNoRepeat(codes: string[], message: string): void {
  const seen = new Set<string>();
  for (const code of codes) {
    if (seen.has(code)) throw new ConflictException(`${message}: ${code}`);
    seen.add(code);
  }
}

/** 요청한 코드 중 INSERT 가 돌려주지 않은 것 — 키가 겹쳐 건너뛰어진 코드다. 요청 순서대로. */
function notCreated(requested: string[], created: string[]): string[] {
  const made = new Set(created);
  return requested.filter((code) => !made.has(code));
}
