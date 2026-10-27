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
  BULK_UPDATE_TX,
  PLATFORM_BP_CODE,
  PLATFORM_PROVIDED_OWNER_CODE,
} from '../code-groups/code-format';
import {
  assertNoRepeat,
  DELETED_BEFORE_SAVE,
  DELETED_MEANWHILE,
  notCreated,
  restoreDeletedItems,
  SAME_AS_LIVE_ITEM,
  takenInOrder,
} from '../code-groups/code-groups.service';
import type { CodeItemInputDto } from '../code-groups/dto/code-item-input.dto';
import { containsText } from '../common/contains-text';
import { PrismaService } from '../prisma/prisma.service';
import type {
  BpCodeGroupListResponseDto,
  BpCodeItemListResponseDto,
} from './dto/bp-code-group.response.dto';
import type { ListBpCodeGroupsDto } from './dto/list-bp-code-groups.dto';

const GROUP_NOT_FOUND = '공통코드 그룹을 찾을 수 없습니다';
const REPEATED_IN_REQUEST = '한 요청에 같은 상세 코드가 두 번 있습니다';

/**
 * BP 가 보는 그룹 — 지우지 않고 사용 중인 플랫폼제공 그룹. 플랫폼고정 · 사용중지 그룹은 보이지 않는다(목록에서 빠지고
 * 상세 코드 조회 · 등록 · 수정 · 삭제는 404, 플랫폼고정은 2026-10-27 사용자 결정). 적용 여부(is_bp_applied)도, 그 BP 에
 * 행이 있는지도 보지 않는다 — 아직 복사되지 않은 그룹은 상세 코드가 빈 목록이고 [BP에 적용]이 채운다. 이 화면의 기준일
 * 뿐이다 — BP 업무 화면이 공통코드 값을 읽는 조회(login-info 공통코드, CodesService)는 플랫폼고정 그룹도 그대로 준다.
 */
const VISIBLE_GROUP = {
  isDeleted: false,
  manageOwnerCode: PLATFORM_PROVIDED_OWNER_CODE,
  status: 'ACTIVE' as const,
};

const itemSelect = {
  itemCode: true,
  label: true,
  status: true,
  sortOrder: true,
  manageOwnerCode: true,
} as const;

/** 플랫폼 원본 상세 코드(BP000000 의 플랫폼제공 행) — 사용중지 안내(isPlatformInactive)에 쓴다. */
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
 * - 플랫폼고정 그룹은 보이지 않는다 — BP 가 고칠 수 없는 시스템 코드다(2026-10-27 사용자 결정).
 * - 플랫폼제공 그룹은 BP 에 적용할 때 복사된 그 BP 의 행을 읽고, 코드명 · 사용 상태 · 표시 순서를 고치거나 BP전용
 *   코드를 더한다. 바꾼 값은 그 BP 에만 적용되고 플랫폼 원래 값을 나란히 두지 않는다.
 * - 사용중지 그룹은 보이지 않는다. 플랫폼제공 그룹의 사용 상태는 BP 가 정한다 — 플랫폼 원본이 사용중지여도 켤 수
 *   있다(2026-10-22 결정).
 * - 코드 값 · 관리 주체는 등록 뒤 바꾸지 않는다. 플랫폼제공 그룹의 그 BP 행은 사용 상태를 자유롭게 바꾸고 논리 삭제한다.
 * - 플랫폼 사용자는 BP 를 골라(X-Bp-Code-Id) 조회만 한다.
 */
@Injectable()
export class BpCodeGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async listGroups(
    bp: TargetBpContext,
    {
      page,
      pageSize,
      groupCode,
      groupName,
      manageOwnerCodes,
    }: ListBpCodeGroupsDto,
  ): Promise<BpCodeGroupListResponseDto> {
    await this.bpCodeOf(bp);
    const where = {
      ...VISIBLE_GROUP,
      // 고른 관리 주체 중 보이는 것(플랫폼제공)만 — 플랫폼고정만 고르면 빈 목록이다. 안 주면 VISIBLE_GROUP 그대로.
      ...(manageOwnerCodes?.length && {
        manageOwnerCode: {
          in: manageOwnerCodes.filter(
            (code) => code === PLATFORM_PROVIDED_OWNER_CODE,
          ),
        },
      }),
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
   * 고른 그룹의 상세 코드(사용중지 포함) — 그 BP 의 행(복사된 플랫폼제공 행 · BP전용)이다.
   * isPlatformInactive 는 같은 코드의 플랫폼 원본이 사용중지인지 — 안내용이다. BP 는 이 값과 관계없이 사용 상태를 바꾼다.
   */
  async listItems(
    bp: TargetBpContext,
    groupCode: string,
  ): Promise<BpCodeItemListResponseDto> {
    const bpCode = await this.bpCodeOf(bp);
    await this.findVisibleGroup(groupCode);
    const rows = await this.prisma.codeItem.findMany({
      where: { groupCode, bpCode, isDeleted: false },
      select: itemSelect,
      orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
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
   * 상세 코드 등록 — 그 BP 의 BP전용 행으로 만든다. 겹침은 살아 있는 행으로만 본다(2026-10-22 결정): 살아 있는 플랫폼
   * 원본과 겹치면 409 — 나중에 다시 BP 에 적용할 때 그 코드가 BP전용 행에 막혀 오지 않으므로 — , 살아 있는 이 BP 행과
   * 겹치면 409. 그 BP 의 지운 행(BP전용 · 복사된 플랫폼제공)과 같은 코드면 그 행의 논리 삭제를 풀고 요청 값으로
   * 되살린다 — 관리 주체는 BP전용으로, 같은 코드의 플랫폼 원본이 살아 있어도(BP 가 지웠다가 다시 쓰는 코드는 BP 의
   * 것으로 본다, 사용자 결정). 그래서 원본과 같은 코드의 BP전용 행이 남을 수 있고, 다시 BP 에 적용해도 그 키는
   * 건너뛴다. 지운 플랫폼 원본은 보지 않는다. 확인과 쓰기가 한 트랜잭션이다 — 한 행이라도 막히면 아무것도 생기지 않는다.
   */
  async createItems(
    callerId: number,
    bp: TargetBpContext,
    groupCode: string,
    items: CodeItemInputDto[],
  ): Promise<void> {
    const bpCode = await this.writableBpCodeOf(bp);
    await this.findVisibleGroup(groupCode);
    assertNoRepeat(
      items.map((c) => c.itemCode),
      REPEATED_IN_REQUEST,
    );
    await this.prisma.$transaction(async (tx) => {
      const requested = items.map((c) => c.itemCode);
      const taken = await tx.codeItem.findMany({
        where: {
          groupCode,
          itemCode: { in: requested },
          bpCode: { in: [bpCode, PLATFORM_BP_CODE] },
        },
        select: { itemCode: true, bpCode: true, isDeleted: true },
      });
      const ownRow = new Map(
        taken.filter((t) => t.bpCode === bpCode).map((t) => [t.itemCode, t]),
      );
      const restorable = new Set(
        [...ownRow.values()].filter((t) => t.isDeleted).map((t) => t.itemCode),
      );
      // 살아 있는 플랫폼 원본 → 살아 있는 이 BP 행 순서로 문구를 고르고, 문구마다 그 경우의 코드를 요청 순서대로 싣는다.
      const livePlatform = takenInOrder(
        requested,
        taken.filter(
          (t) =>
            t.bpCode === PLATFORM_BP_CODE &&
            !t.isDeleted &&
            !restorable.has(t.itemCode),
        ),
      );
      if (livePlatform.length)
        throw new ConflictException(
          `플랫폼이 등록한 상세 코드와 겹칩니다: ${livePlatform.join(', ')}`,
        );
      const liveOwn = takenInOrder(
        requested,
        [...ownRow.values()].filter((t) => !t.isDeleted),
      );
      if (liveOwn.length)
        throw new ConflictException(
          `${SAME_AS_LIVE_ITEM}: ${liveOwn.join(', ')}`,
        );

      await restoreDeletedItems(
        tx,
        groupCode,
        bpCode,
        items.filter((c) => restorable.has(c.itemCode)),
        callerId,
        // 지운 복사본을 BP 가 다시 등록하면 BP 가 새로 만든 코드로 본다 — 플랫폼제공이었어도 BP전용으로 되살린다.
        BP_ONLY_OWNER_CODE,
      );
      const fresh = items.filter((c) => !restorable.has(c.itemCode));
      if (!fresh.length) return;

      // 위 확인과 INSERT 사이에 같은 BP 의 다른 관리자가 같은 코드를 넣으면 키가 겹친다. 건너뛰고 409 로 되돌린다 —
      // 그대로 두면 키 위반이 500 으로 나간다. 메시지에는 만들지 못한 코드만.
      const created = await tx.codeItem.createManyAndReturn({
        data: fresh.map((c) => ({
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
        fresh.map((c) => c.itemCode),
        created.map((c) => c.itemCode),
      );
      if (lost.length)
        throw new ConflictException(`${SAME_AS_LIVE_ITEM}: ${lost.join(', ')}`);
    }, BULK_UPDATE_TX);
  }

  /**
   * 상세 코드 수정 — 그 BP 의 지우지 않은 행(복사된 플랫폼제공 행 · BP전용)만, 코드명 · 사용 상태 · 표시 순서만 고친다.
   * 사용 상태는 BP 가 자유롭게 바꾼다 — 플랫폼 원본이 사용중지여도 켤 수 있다(2026-10-22 결정). 한 행이라도 없으면
   * 아무것도 고치지 않는다. 쓰기도 지우지 않은 행에만 걸어, 확인 뒤 다른 관리자가 지운 행은 고치지 않고 409.
   */
  async updateItems(
    callerId: number,
    bp: TargetBpContext,
    groupCode: string,
    items: CodeItemInputDto[],
  ): Promise<void> {
    const bpCode = await this.writableBpCodeOf(bp);
    await this.findVisibleGroup(groupCode);
    assertNoRepeat(
      items.map((u) => u.itemCode),
      REPEATED_IN_REQUEST,
    );
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.codeItem.findMany({
        where: {
          groupCode,
          bpCode,
          isDeleted: false,
          itemCode: { in: items.map((u) => u.itemCode) },
        },
        select: { itemCode: true },
      });
      const found = new Set(rows.map((r) => r.itemCode));
      const missing = items.find((u) => !found.has(u.itemCode));
      if (missing)
        throw new NotFoundException(
          `상세 코드를 찾을 수 없습니다: ${missing.itemCode}`,
        );

      for (const { itemCode, label, status, sortOrder } of items) {
        const { count } = await tx.codeItem.updateMany({
          where: { groupCode, itemCode, bpCode, isDeleted: false },
          data: { label, status, sortOrder, updatedBy: callerId },
        });
        if (count === 0)
          throw new ConflictException(`${DELETED_BEFORE_SAVE}: ${itemCode}`);
      }
    }, BULK_UPDATE_TX);
  }

  /**
   * 상세 코드 삭제(논리) — 그 BP 의 지우지 않은 행. 플랫폼제공 그룹의 행은 모두 그 BP 의 것이라 BP전용 행도, 복사된
   * 플랫폼제공 행도 지운다 — 플랫폼 원본 · 다른 BP 는 그대로다. 지운 행은 [BP에 적용]을 다시 눌러도 되살아나지 않고(이미
   * 있는 키는 건너뛴다), 같은 코드로 다시 등록하면 되살아난다(createItems). 한 건이라도 없으면 아무것도 지우지 않는다.
   * 확인 뒤 다른 관리자가 먼저 지웠으면 지운 행 수가 모자라 409 로 되돌린다.
   */
  async deleteItems(
    callerId: number,
    bp: TargetBpContext,
    groupCode: string,
    itemCodes: string[],
  ): Promise<void> {
    const bpCode = await this.writableBpCodeOf(bp);
    await this.findVisibleGroup(groupCode);
    assertNoRepeat(itemCodes, REPEATED_IN_REQUEST);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.codeItem.findMany({
        where: {
          groupCode,
          bpCode,
          isDeleted: false,
          itemCode: { in: itemCodes },
        },
        select: { itemCode: true },
      });
      const found = new Set(rows.map((r) => r.itemCode));
      const missing = itemCodes.find((code) => !found.has(code));
      if (missing)
        throw new NotFoundException(`상세 코드를 찾을 수 없습니다: ${missing}`);

      const { count } = await tx.codeItem.updateMany({
        where: {
          groupCode,
          bpCode,
          isDeleted: false,
          itemCode: { in: itemCodes },
        },
        data: { isDeleted: true, updatedBy: callerId },
      });
      if (count !== itemCodes.length)
        throw new ConflictException(DELETED_MEANWHILE);
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

  /** 등록 · 수정 · 삭제의 대상 BP. 플랫폼 사용자는 메뉴 권한이 있어도 조회만 한다 — 403. */
  private async writableBpCodeOf(bp: TargetBpContext): Promise<string> {
    if (bp.isPlatformCaller)
      throw new ForbiddenException(
        '플랫폼 사용자는 BP 공통코드를 조회만 할 수 있습니다',
      );
    return this.bpCodeOf(bp);
  }

  /** 보이는 그룹(VISIBLE_GROUP)이어야 상세 코드를 읽고 더하고 고치고 지운다. 아니면 404. */
  private async findVisibleGroup(groupCode: string): Promise<void> {
    const group = await this.prisma.codeGroup.findFirst({
      where: { groupCode, ...VISIBLE_GROUP },
      select: { groupCode: true },
    });
    if (!group) throw new NotFoundException(GROUP_NOT_FOUND);
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
