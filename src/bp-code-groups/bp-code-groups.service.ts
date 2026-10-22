import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import {
  BP_ONLY_OWNER_CODE,
  PLATFORM_BP_CODE,
} from '../code-groups/code-format';
import { assertNoRepeat, notCreated } from '../code-groups/code-groups.service';
import type { CodeItemInputDto } from '../code-groups/dto/code-item-input.dto';
import { containsText } from '../common/contains-text';
import { PrismaService } from '../prisma/prisma.service';
import type {
  BpCodeGroupListResponseDto,
  BpCodeItemListResponseDto,
} from './dto/bp-code-group.response.dto';
import type { ListBpCodeGroupsDto } from './dto/list-bp-code-groups.dto';

const PLATFORM_FIXED = 'PLATFORM_FIXED';
const GROUP_NOT_FOUND = '공통코드 그룹을 찾을 수 없습니다';
const SAME_AS_BP_ROW = '이 그룹에 이미 있는 상세 코드입니다';
const REPEATED_IN_REQUEST = '한 요청에 같은 상세 코드가 두 번 있습니다';
const PLATFORM_STOPPED =
  '플랫폼이 사용 중지한 코드는 다시 사용으로 바꿀 수 없습니다';

/**
 * BP 가 보는 그룹 — 플랫폼고정 그룹과 BP 에 적용한 플랫폼제공 그룹. 사용중지 그룹도 보인다(읽기 전용).
 * 적용하지 않은 플랫폼제공 그룹은 BP 에 행이 없어 보이지 않는다.
 */
const VISIBLE_GROUP = {
  isDeleted: false,
  OR: [
    { manageOwnerCode: PLATFORM_FIXED },
    { manageOwnerCode: 'PLATFORM_PROVIDED', isBpApplied: true },
  ],
};

const itemSelect = {
  itemCode: true,
  label: true,
  status: true,
  sortOrder: true,
  manageOwnerCode: true,
} as const;

/** 플랫폼 원본 상세 코드(BP000000 의 플랫폼고정 · 플랫폼제공 행). */
const platformOriginal = (groupCode: string) => ({
  groupCode,
  bpCode: PLATFORM_BP_CODE,
  isDeleted: false,
  manageOwnerCode: { not: BP_ONLY_OWNER_CODE },
});

/**
 * BP 공통코드 관리 (S-FHVSAV · F-QPDEWN · PL-VOCZCE · CONFIG-7). 그룹은 플랫폼이 만들고 여기서는 읽기만 한다 —
 * BP 가 다루는 단위는 상세 코드뿐이다.
 *
 * - 플랫폼고정 그룹은 복사 없이 플랫폼 원본을 읽기만 한다.
 * - 플랫폼제공 그룹은 BP 에 적용할 때 복사된 그 BP 의 행을 읽고, 코드명 · 사용 상태 · 표시 순서를 고치거나 BP전용
 *   코드를 더한다. 바꾼 값은 그 BP 에만 적용되고 플랫폼 원래 값을 나란히 두지 않는다.
 * - 사용중지 그룹은 더하거나 고치지 못하고, 플랫폼이 사용 중지한 코드는 BP 가 다시 켜지 못한다.
 * - 코드 값 · 관리 주체는 등록 뒤 바꾸지 않고, 삭제는 없다(사용 상태를 끈다).
 * - 플랫폼 사용자는 BP 를 골라(X-Bp-Code-Id) 조회만 한다.
 */
@Injectable()
export class BpCodeGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async listGroups(
    bp: TargetBpContext,
    { page, pageSize, groupCode, groupName }: ListBpCodeGroupsDto,
  ): Promise<BpCodeGroupListResponseDto> {
    await this.bpCodeOf(bp);
    const where = {
      ...VISIBLE_GROUP,
      ...(groupCode && { groupCode: containsText(groupCode) }),
      ...(groupName && { groupName: containsText(groupName) }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.codeGroup.findMany({
        where,
        select: {
          groupCode: true,
          groupName: true,
          manageOwnerCode: true,
          status: true,
          sortOrder: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { groupCode: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.codeGroup.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * 고른 그룹의 상세 코드(사용중지 포함). 플랫폼고정은 플랫폼 원본, 플랫폼제공은 그 BP 의 행(복사된 행 · BP전용)이다.
   * isPlatformInactive 는 같은 코드의 플랫폼 원본이 사용중지인지 — 화면이 사용 토글을 막는 데 쓴다.
   */
  async listItems(
    bp: TargetBpContext,
    groupCode: string,
  ): Promise<BpCodeItemListResponseDto> {
    const bpCode = await this.bpCodeOf(bp);
    const group = await this.findVisibleGroup(groupCode);
    const orderBy = [
      { sortOrder: 'asc' as const },
      { itemCode: 'asc' as const },
    ];

    if (group.manageOwnerCode === PLATFORM_FIXED) {
      const rows = await this.prisma.codeItem.findMany({
        where: platformOriginal(groupCode),
        select: itemSelect,
        orderBy,
      });
      const items = rows.map((r) => ({
        ...r,
        isPlatformInactive: r.status === 'INACTIVE',
      }));
      return { items, total: items.length };
    }

    const rows = await this.prisma.codeItem.findMany({
      where: { groupCode, bpCode, isDeleted: false },
      select: itemSelect,
      orderBy,
    });
    const inactive = await this.platformInactiveCodes(
      this.prisma,
      groupCode,
      rows.map((r) => r.itemCode),
    );
    const items = rows.map((r) => ({
      ...r,
      isPlatformInactive: inactive.has(r.itemCode),
    }));
    return { items, total: items.length };
  }

  /**
   * 상세 코드 등록 — 그 BP 의 BP전용 행으로 만든다. 같은 그룹의 플랫폼 원본 · 그 BP 의 행(지운 것 포함)과 겹칠 수
   * 없다 — 플랫폼 원본과 겹치면 나중에 다시 BP 에 적용할 때 그 코드가 BP전용 행에 막혀 오지 않는다. 확인과 INSERT 가
   * 한 트랜잭션이다 — 한 행이라도 막히면 아무것도 생기지 않는다.
   */
  async createItems(
    callerId: number,
    bp: TargetBpContext,
    groupCode: string,
    items: CodeItemInputDto[],
  ): Promise<void> {
    const bpCode = await this.writableBpCodeOf(bp);
    await this.findWritableGroup(groupCode);
    assertNoRepeat(
      items.map((c) => c.itemCode),
      REPEATED_IN_REQUEST,
    );
    await this.prisma.$transaction(async (tx) => {
      const taken = await tx.codeItem.findMany({
        where: {
          groupCode,
          itemCode: { in: items.map((c) => c.itemCode) },
          bpCode: { in: [bpCode, PLATFORM_BP_CODE] },
        },
        select: { itemCode: true, bpCode: true },
      });
      const platformTaken = taken.find((t) => t.bpCode === PLATFORM_BP_CODE);
      if (platformTaken)
        throw new ConflictException(
          `플랫폼이 등록한 상세 코드와 겹칩니다: ${platformTaken.itemCode}`,
        );
      if (taken.length)
        throw new ConflictException(`${SAME_AS_BP_ROW}: ${taken[0].itemCode}`);

      // 위 확인과 INSERT 사이에 같은 BP 의 다른 관리자가 같은 코드를 넣으면 키가 겹친다. 건너뛰고 409 로 되돌린다 —
      // 그대로 두면 키 위반이 500 으로 나간다. 메시지에는 만들지 못한 코드만.
      const created = await tx.codeItem.createManyAndReturn({
        data: items.map((c) => ({
          groupCode,
          bpCode,
          itemCode: c.itemCode,
          label: c.label,
          status: c.status,
          sortOrder: c.sortOrder,
          manageOwnerCode: BP_ONLY_OWNER_CODE,
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
        throw new ConflictException(`${SAME_AS_BP_ROW}: ${lost.join(', ')}`);
    });
  }

  /**
   * 상세 코드 수정 — 그 BP 의 지우지 않은 행(복사된 플랫폼제공 행 · BP전용)만, 코드명 · 사용 상태 · 표시 순서만 고친다.
   * 플랫폼 원본이 사용중지인 코드를 사용중지 → 사용으로 켜면 409. 이미 사용 중인 행은 그대로 둔다 — 화면이 패널
   * 전체를 보내므로, 원본이 나중에 중지됐다고 저장 전체를 막지 않는다. 그 행은 「지금도 사용 중」을 조건으로 쓴다 —
   * 읽은 뒤 같은 BP 의 다른 관리자가 껐으면 이 저장이 다시 켜는 셈이라 409. 한 행이라도 막히면 아무것도 고치지 않는다.
   */
  async updateItems(
    callerId: number,
    bp: TargetBpContext,
    groupCode: string,
    items: CodeItemInputDto[],
  ): Promise<void> {
    const bpCode = await this.writableBpCodeOf(bp);
    await this.findWritableGroup(groupCode);
    assertNoRepeat(
      items.map((u) => u.itemCode),
      REPEATED_IN_REQUEST,
    );
    await this.prisma.$transaction(async (tx) => {
      const codes = items.map((u) => u.itemCode);
      const rows = await tx.codeItem.findMany({
        where: { groupCode, bpCode, isDeleted: false, itemCode: { in: codes } },
        select: { itemCode: true, status: true },
      });
      const statusOf = new Map(rows.map((r) => [r.itemCode, r.status]));
      const missing = items.find((u) => !statusOf.has(u.itemCode));
      if (missing)
        throw new NotFoundException(
          `상세 코드를 찾을 수 없습니다: ${missing.itemCode}`,
        );

      const inactive = await this.platformInactiveCodes(tx, groupCode, codes);
      const revived = items.find(
        (u) =>
          u.status === 'ACTIVE' &&
          statusOf.get(u.itemCode) === 'INACTIVE' &&
          inactive.has(u.itemCode),
      );
      if (revived)
        throw new ConflictException(`${PLATFORM_STOPPED}: ${revived.itemCode}`);

      for (const { itemCode, label, status, sortOrder } of items) {
        const data = { label, status, sortOrder, updatedBy: callerId };
        if (status === 'ACTIVE' && inactive.has(itemCode)) {
          const kept = await tx.codeItem.updateMany({
            where: { groupCode, itemCode, bpCode, status: 'ACTIVE' },
            data,
          });
          if (kept.count === 0)
            throw new ConflictException(`${PLATFORM_STOPPED}: ${itemCode}`);
          continue;
        }
        await tx.codeItem.update({
          where: {
            groupCode_itemCode_bpCode: { groupCode, itemCode, bpCode },
          },
          data,
        });
      }
    });
  }

  /**
   * 가드가 정한 대상 BP 의 코드. 플랫폼 사용자가 헤더 없이 부르면 가드는 플랫폼 BP 를 두므로 400 — 플랫폼 BP 의
   * 공통코드는 플랫폼 공통코드 관리의 몫이다. 가드 뒤에 지워졌으면 404.
   */
  private async bpCodeOf(bp: TargetBpContext): Promise<string> {
    const row = await this.prisma.bpCode.findFirst({
      where: { bpCodeId: bp.bpCodeId, isDeleted: false },
      select: { bpCode: true, isPlatform: true },
    });
    if (!row) throw new NotFoundException('BP 를 찾을 수 없습니다');
    if (row.isPlatform)
      throw new BadRequestException('공통코드를 볼 BP 를 골라 주세요');
    return row.bpCode;
  }

  /** 등록 · 수정의 대상 BP. 플랫폼 사용자는 메뉴 권한이 있어도 조회만 한다 — 403. */
  private async writableBpCodeOf(bp: TargetBpContext): Promise<string> {
    if (bp.isPlatformCaller)
      throw new ForbiddenException(
        '플랫폼 사용자는 BP 공통코드를 조회만 할 수 있습니다',
      );
    return this.bpCodeOf(bp);
  }

  private async findVisibleGroup(groupCode: string) {
    const group = await this.prisma.codeGroup.findFirst({
      where: { groupCode, ...VISIBLE_GROUP },
      select: { groupCode: true, manageOwnerCode: true, status: true },
    });
    if (!group) throw new NotFoundException(GROUP_NOT_FOUND);
    return group;
  }

  /** 상세 코드를 더하거나 고칠 수 있는 그룹 — 보이는 그룹 중 사용 중인 플랫폼제공. 아니면 409. */
  private async findWritableGroup(groupCode: string) {
    const group = await this.findVisibleGroup(groupCode);
    if (group.manageOwnerCode === PLATFORM_FIXED)
      throw new ConflictException('플랫폼고정 그룹은 조회만 할 수 있습니다');
    if (group.status !== 'ACTIVE')
      throw new ConflictException(
        '사용 중지된 그룹은 상세 코드를 추가하거나 고칠 수 없습니다',
      );
    return group;
  }

  /** 주어진 코드 중 플랫폼 원본이 사용중지인 것. BP전용 코드는 원본이 없어 들지 않는다. */
  private async platformInactiveCodes(
    db: Pick<PrismaService, 'codeItem'>,
    groupCode: string,
    itemCodes: string[],
  ): Promise<Set<string>> {
    const originals = await db.codeItem.findMany({
      where: { ...platformOriginal(groupCode), itemCode: { in: itemCodes } },
      select: { itemCode: true, status: true },
    });
    return new Set(
      originals.filter((o) => o.status === 'INACTIVE').map((o) => o.itemCode),
    );
  }
}
