import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { containsText } from '../common/contains-text';
import { isSameMillisecond, sameMillisecond } from '../common/updated-at';
import { CHANGED_MEANWHILE } from '../platform-menus/platform-menu-format';
import { PrismaService } from '../prisma/prisma.service';
import {
  BP_ONLY_OWNER_CODE,
  BULK_UPDATE_TX,
  INT4_MAX,
  PLATFORM_BP_CODE,
  PLATFORM_FIXED_OWNER_CODE,
  PLATFORM_OWNER_CODES,
  PLATFORM_PROVIDED_OWNER_CODE,
} from './code-format';
import { copyProvidedItems, providedOriginals } from './provided-code-copy';
import type {
  BpApplicationResponseDto,
  CodeGroupListResponseDto,
  CodeItemListResponseDto,
} from './dto/code-group.response.dto';
import type { ListCodeGroupsDto } from './dto/list-code-groups.dto';
import type { CodeItemInputDto } from './dto/code-item-input.dto';
import type { CreateCodeGroupDto } from './dto/create-code-groups.dto';
import type { UpdateCodeGroupDto } from './dto/update-code-groups.dto';
import type { UpdateCodeItemDto } from './dto/update-code-items.dto';

const GROUP_NOT_FOUND = '공통코드 그룹을 찾을 수 없습니다.';

const groupSelect = {
  groupCode: true,
  groupName: true,
  manageOwnerCode: true,
  isBpApplied: true,
  status: true,
  sortOrder: true,
  updatedAt: true,
} as const;
const itemSelect = {
  itemCode: true,
  label: true,
  status: true,
  sortOrder: true,
  updatedAt: true,
} as const;

/** 이 화면의 그룹(지우지 않은 플랫폼고정 · 플랫폼제공) — 새 그룹의 표시 순서를 이 안에서 매긴다. */
const PLATFORM_GROUP = {
  isDeleted: false,
  manageOwnerCode: { in: [...PLATFORM_OWNER_CODES] },
};

/**
 * 플랫폼 공통코드 관리 (S-UQPNIH · F-LOUVWE). 플랫폼고정 · 플랫폼제공 그룹과 그 플랫폼 원본(BP000000)
 * 상세 코드만 다룬다. BP 가 추가한 BP전용 상세 코드는 보이지도 고쳐지지도 않는다(PL-VOCZCE).
 *
 * 코드 · 관리 주체는 등록 뒤 바꾸지 않는다 — 수정 요청은 이름 · 사용 상태 · 표시 순서만 쓰고, 행마다 목록에서 받은
 * updatedAt 과 같은 ms 일 때만 고친다(하나라도 다르면 요청 전체 409, 2026-10-30).
 * 물리 삭제는 없다. 등록 · 수정 이력은 아직 쓰지 않는다(이력 테이블이 생기면 여기서 남긴다).
 */
@Injectable()
export class CodeGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 그룹 목록. 그룹 코드 · 그룹명은 대소문자 없이 글자 그대로 들어 있음으로 찾는다(LIKE 와일드카드를 막는 containsText). */
  async listGroups({
    page,
    pageSize,
    groupCode,
    groupName,
    manageOwnerCodes,
  }: ListCodeGroupsDto): Promise<CodeGroupListResponseDto> {
    const where = {
      isDeleted: false,
      // 고른 관리 주체만 — 빈 값 · 안 주면 둘 다
      manageOwnerCode: {
        in: manageOwnerCodes?.length
          ? manageOwnerCodes
          : [...PLATFORM_OWNER_CODES],
      },
      ...(groupCode && { groupCode: containsText(groupCode) }),
      ...(groupName && { groupName: containsText(groupName) }),
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
   * 아무것도 생기지 않는다. 표시 순서는 이 화면의 그룹 전체의 최대 + 1 부터 요청 순서대로 매긴다(2026-10-30) — 동시
   * 등록이 같은 최대를 읽지 않게 트랜잭션 잠금 뒤에 읽고, integer 를 넘치게 매길 것이면 409 다.
   */
  async createGroups(
    callerId: number,
    items: CreateCodeGroupDto[],
  ): Promise<void> {
    assertNoRepeat(
      items.map((c) => c.groupCode),
      GROUP_CODE_TAKEN,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('code_groups.sort_order'))`;
      // 지운 그룹도 함께 읽는다 — 지운 그룹의 코드도 다시 쓰지 않는다.
      const found = await tx.codeGroup.findMany({
        where: { groupCode: { in: items.map((g) => g.groupCode) } },
        select: { groupCode: true },
      });
      const takenCodes = new Set(found.map((g) => g.groupCode));
      const taken = items.find((c) => takenCodes.has(c.groupCode));
      if (taken)
        throw new ConflictException(
          withCodes(GROUP_CODE_TAKEN, [taken.groupCode]),
        );
      const { _max } = await tx.codeGroup.aggregate({
        where: PLATFORM_GROUP,
        _max: { sortOrder: true },
      });
      const lastOrder = _max.sortOrder ?? 0;
      // 수정은 표시 순서를 integer 최댓값까지 받는다 — 넘치게 매기면 DB 가 거부해 500 이 되므로 먼저 막는다.
      if (lastOrder + items.length > INT4_MAX)
        throw new ConflictException(SORT_ORDER_EXHAUSTED);

      // 위 확인과 INSERT 사이에 다른 관리자가 같은 코드를 넣으면 키가 겹친다. 건너뛰고 409 로 되돌린다 —
      // 그대로 두면 키 위반이 500 으로 나간다. 이번 INSERT 가 만든 행을 돌려받아 만들지 못한 코드(먼저
      // 들어간 것)만 알린다. 뒤에 다시 읽으면 이번 트랜잭션이 넣은 행과 구분할 수 없다.
      const created = await tx.codeGroup.createManyAndReturn({
        data: items.map((c, i) => ({
          groupCode: c.groupCode,
          groupName: c.groupName,
          manageOwnerCode: c.manageOwnerCode,
          status: c.status,
          sortOrder: lastOrder + 1 + i,
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
        throw new ConflictException(withCodes(GROUP_CODE_TAKEN, lost));
    }, BULK_UPDATE_TX);
  }

  /**
   * 그룹 수정. 지우지 않은 플랫폼고정 · 플랫폼제공 그룹만, 그룹명 · 사용 상태 · 표시 순서만 고친다.
   * 한 행이라도 없으면 아무것도 고치지 않는다(한 트랜잭션). 같은 그룹 코드가 두 번 오면 어느 값을 남길지
   * 정할 수 없으므로 DB 에 묻기 전에 409. 행마다 받은 updatedAt 과 같은 ms 일 때만 쓴다 — 읽은 뒤 다른 관리자가 고친
   * 행이 하나라도 있으면 409(CHANGED_MEANWHILE)로 모두 되돌린다.
   */
  async updateGroups(
    callerId: number,
    items: UpdateCodeGroupDto[],
  ): Promise<void> {
    assertNoRepeat(
      items.map((g) => g.groupCode),
      '한 요청에 같은 그룹 코드가 두 번 있습니다',
    );
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.codeGroup.findMany({
        where: { groupCode: { in: items.map((g) => g.groupCode) } },
        select: {
          groupCode: true,
          manageOwnerCode: true,
          isDeleted: true,
          updatedAt: true,
        },
      });
      const byCode = new Map(found.map((g) => [g.groupCode, g]));
      for (const { groupCode } of items) {
        const g = byCode.get(groupCode);
        if (!g || g.isDeleted || !isPlatformOwner(g.manageOwnerCode))
          throw new NotFoundException(
            withCodes('공통코드 그룹을 찾을 수 없습니다', [groupCode]),
          );
      }
      if (
        items.some(
          (g) =>
            !isSameMillisecond(byCode.get(g.groupCode)!.updatedAt, g.updatedAt),
        )
      )
        throw new ConflictException(CHANGED_MEANWHILE);

      for (const {
        groupCode,
        groupName,
        status,
        sortOrder,
        updatedAt,
      } of items) {
        // 확인과 쓰기 사이에 고친 행도 막는다 — 같은 ms 인 행에만 쓴다(그룹을 지우는 API 가 없으므로 0건이면 고친 것이다).
        const { count } = await tx.codeGroup.updateMany({
          where: {
            groupCode,
            isDeleted: false,
            updatedAt: sameMillisecond(updatedAt),
          },
          data: { groupName, status, sortOrder, updatedBy: callerId },
        });
        if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
      }
    }, BULK_UPDATE_TX);
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
   * 상세 코드 등록. 플랫폼 원본(BP000000)에 소속 그룹의 관리 주체로 만든다. 같은 그룹의 살아 있는 원본, 또는 어느 BP 의
   * 살아 있는 BP전용 행과 겹치면 409 — BP전용 행은 그 BP 가 만든 코드라 [BP에 적용]이 건너뛰어 원본이 닿지 않는다.
   * BP 에 살아 있는 플랫폼제공 복사본은 겹침이 아니다(2026-10-30 결정 — 막으면 [BP에 적용] 뒤 지운 코드를 영영 다시
   * 못 만든다): 지운 원본과 같은 코드면 그 원본의 논리 삭제를 풀고 요청 값으로 되살리고(2026-10-22 결정), 복사본은
   * 그대로 두며 다시 [BP에 적용]해도 이미 있는 키라 건너뛴다. 지운 행 · 복사본만 있고 원본 행이 없으면(직접 SQL 이 아니면
   * 생기지 않는다) 새 원본을 만든다 — 키에 BP 가 있어 복사본과 겹치지 않는다. 확인과 쓰기가 한 트랜잭션이다 — 한 행이라도
   * 막히면 아무것도 생기지 않는다.
   */
  async createItems(
    callerId: number,
    groupCode: string,
    items: CodeItemInputDto[],
  ): Promise<void> {
    const group = await this.findPlatformGroup(groupCode);
    assertNoRepeat(
      items.map((c) => c.itemCode),
      SAME_AS_LIVE_ITEM,
    );
    await this.prisma.$transaction(async (tx) => {
      const requested = items.map((c) => c.itemCode);
      const taken = await tx.codeItem.findMany({
        where: { groupCode, itemCode: { in: requested } },
        select: {
          itemCode: true,
          bpCode: true,
          isDeleted: true,
          manageOwnerCode: true,
        },
      });
      const live = takenInOrder(
        requested,
        taken.filter(
          (t) =>
            !t.isDeleted &&
            (t.bpCode === PLATFORM_BP_CODE ||
              t.manageOwnerCode === BP_ONLY_OWNER_CODE),
        ),
      );
      if (live.length)
        throw new ConflictException(withCodes(SAME_AS_LIVE_ITEM, live));

      const deletedOriginals = new Set(
        taken
          .filter((t) => t.isDeleted && t.bpCode === PLATFORM_BP_CODE)
          .map((t) => t.itemCode),
      );
      await restoreDeletedItems(
        tx,
        groupCode,
        PLATFORM_BP_CODE,
        items.filter((c) => deletedOriginals.has(c.itemCode)),
        callerId,
      );
      const fresh = items.filter((c) => !deletedOriginals.has(c.itemCode));
      if (!fresh.length) return;

      // 그룹 등록과 같다 — 확인 뒤 끼어든 같은 코드는 500 이 아니라 409, 메시지에는 겹친 코드만.
      const created = await tx.codeItem.createManyAndReturn({
        data: fresh.map((c) => ({
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
        fresh.map((c) => c.itemCode),
        created.map((c) => c.itemCode),
      );
      if (lost.length)
        throw new ConflictException(withCodes(SAME_AS_LIVE_ITEM, lost));
    }, BULK_UPDATE_TX);
  }

  /**
   * 상세 코드 수정. 이 그룹의 플랫폼 원본(BP전용 · 지운 행 제외)만, 코드명 · 사용 상태 · 표시 순서만 고친다.
   * 한 행이라도 없으면 아무것도 고치지 않는다(한 트랜잭션). 같은 코드가 두 번 오면 DB 에 묻기 전에 409. 행마다 받은
   * updatedAt 과 같은 ms 일 때만 쓴다 — 읽은 뒤 다른 관리자가 고친 행이 있으면 409(CHANGED_MEANWHILE), 지운 행이면
   * 409(deletedBeforeSave)로 모두 되돌린다.
   */
  async updateItems(
    callerId: number,
    groupCode: string,
    items: UpdateCodeItemDto[],
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
        select: { itemCode: true, updatedAt: true },
      });
      assertItemsUnchanged(editable, items);

      const original = {
        groupCode,
        bpCode: PLATFORM_BP_CODE,
        isDeleted: false,
        manageOwnerCode: { not: BP_ONLY_OWNER_CODE },
      };
      for (const { itemCode, label, status, sortOrder, updatedAt } of items) {
        const { count } = await tx.codeItem.updateMany({
          where: {
            ...original,
            itemCode,
            updatedAt: sameMillisecond(updatedAt),
          },
          data: { label, status, sortOrder, updatedBy: callerId },
        });
        if (count === 0) await throwUnsaved(tx, { ...original, itemCode });
      }
    }, BULK_UPDATE_TX);
  }

  /**
   * 상세 코드 삭제(논리). 플랫폼제공 그룹의 지우지 않은 플랫폼 원본(BP전용 제외)만, BP 가 쓰는지와 관계없이 지운다 —
   * 이미 BP 에 복사된 행은 그 BP 의 것이라 건드리지 않고, 지운 원본은 그 뒤 [BP에 적용] · 회원가입 복사에서 빠진다.
   * 플랫폼고정 그룹은 409 — 시스템이 그 값을 참조하므로(SERVICE 를 메뉴가, ROLE_TYPE 을 계정이) 지우면 그 기능이
   * 깨진다. 사용 상태로만 관리한다. 같은 코드로 다시 등록하면 되살아난다 — BP 에 플랫폼제공 복사본이 살아 있어도
   * 되살린다(2026-10-30). 한 건이라도 없으면 아무것도 지우지 않는다(한 트랜잭션). 확인 뒤 다른 관리자가 먼저 지웠으면 지운
   * 행 수가 모자라 409 로 되돌린다.
   */
  async deleteItems(
    callerId: number,
    groupCode: string,
    itemCodes: string[],
  ): Promise<void> {
    const group = await this.findPlatformGroup(groupCode);
    if (group.manageOwnerCode === PLATFORM_FIXED_OWNER_CODE)
      throw new ConflictException(FIXED_NOT_DELETABLE);
    assertNoRepeat(itemCodes, '한 요청에 같은 상세 코드가 두 번 있습니다');
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.codeItem.findMany({
        where: {
          groupCode,
          bpCode: PLATFORM_BP_CODE,
          isDeleted: false,
          manageOwnerCode: { not: BP_ONLY_OWNER_CODE },
          itemCode: { in: itemCodes },
        },
        select: { itemCode: true },
      });
      const foundCodes = new Set(found.map((i) => i.itemCode));
      const missing = itemCodes.find((code) => !foundCodes.has(code));
      if (missing) throw new NotFoundException(itemNotFound(missing));

      const { count } = await tx.codeItem.updateMany({
        where: {
          groupCode,
          bpCode: PLATFORM_BP_CODE,
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
    if (group.manageOwnerCode !== PLATFORM_PROVIDED_OWNER_CODE)
      throw new ConflictException('플랫폼제공 그룹만 BP에 적용할 수 있습니다.');

    return this.prisma.$transaction(
      async (tx) => {
        const originals = await providedOriginals(tx, [groupCode]);
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
            '상세 코드가 없는 그룹은 BP에 적용할 수 없습니다.',
          );
        if (!bpCodes.length)
          throw new ConflictException('적용할 사용 중인 고객 BP 가 없습니다.');

        // 이미 있는 행은 건너뛴다 — 덮어쓰지 않는다(copyProvidedItems, 회원가입과 같은 함수).
        const createdCount = await copyProvidedItems(
          tx,
          originals,
          bpCodes,
          callerId,
        );
        await tx.codeGroup.update({
          where: { groupCode },
          data: { isBpApplied: true, updatedBy: callerId },
        });
        return {
          bpCount: bpCodes.length,
          itemCount: originals.length,
          createdCount,
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

const FIXED_NOT_DELETABLE =
  '플랫폼고정 그룹의 상세 코드는 지울 수 없습니다 — 사용 상태로 관리해 주세요.';

/**
 * 상세 코드 등록이 같은 그룹의 살아 있는 플랫폼 원본 또는 BP전용 행과 겹칠 때(BP 의 플랫폼제공 복사본 · 지운 행은 겹침이
 * 아니다). 되살리기 · INSERT 경합의 409 에도 쓴다.
 */
export const SAME_AS_LIVE_ITEM = '이 그룹에 이미 있는 상세 코드입니다';

/**
 * 지운 상세 코드 행을 요청 값(코드명 · 사용 상태 · 표시 순서)으로 되살린다 — 플랫폼 · BP 공통코드 관리의 등록이 같은
 * 코드로 다시 등록할 때 쓴다. 처음 등록한 사람은 그대로이고, 관리 주체는 `manageOwnerCode` 를 주면 그 값으로 바꾸고
 * 안 주면 그대로다(BP 공통코드 관리는 BP전용으로 바꾼다). 아직 지운 상태일 때만 바꾸므로, 확인 뒤 다른 요청이 같은
 * 코드를 먼저 되살렸으면 0건이고 409 로 되돌린다.
 */
export async function restoreDeletedItems(
  tx: Prisma.TransactionClient,
  groupCode: string,
  bpCode: string,
  items: CodeItemInputDto[],
  callerId: number,
  manageOwnerCode?: typeof BP_ONLY_OWNER_CODE,
): Promise<void> {
  for (const { itemCode, label, status, sortOrder } of items) {
    const { count } = await tx.codeItem.updateMany({
      where: { groupCode, itemCode, bpCode, isDeleted: true },
      data: {
        label,
        status,
        sortOrder,
        isDeleted: false,
        updatedBy: callerId,
        ...(manageOwnerCode && { manageOwnerCode }),
      },
    });
    if (count === 0)
      throw new ConflictException(withCodes(SAME_AS_LIVE_ITEM, [itemCode]));
  }
}

/** 요청한 코드 중 겹친 행이 있는 것 — 요청 순서대로, 한 번씩(한 코드에 BP 별 행이 여럿일 수 있다). */
export function takenInOrder(
  requested: string[],
  taken: { itemCode: string }[],
): string[] {
  const hit = new Set(taken.map((t) => t.itemCode));
  return requested.filter((code) => hit.has(code));
}

/** 그룹 등록이 이미 있는(지운 것 포함) 그룹 코드와 겹칠 때. front 화면 문구와 같은 말이다. */
const GROUP_CODE_TAKEN = '이미 사용 중인 그룹 코드입니다';

const SORT_ORDER_EXHAUSTED =
  '표시 순서가 최댓값에 닿아 더 등록할 수 없습니다. 기존 그룹의 표시 순서를 줄인 뒤 다시 등록해 주세요.';

/**
 * 문구 끝에 코드 목록을 괄호로 — `이 그룹에 이미 있는 상세 코드입니다(A, B).`(2026-10-30, 메뉴 관리와 같은 꼴). front 는
 * 문구 앞부분으로 칸을 가르고 마지막 괄호 안을 `, ` 로 나눠 읽는다.
 */
export function withCodes(message: string, codes: string[]): string {
  return `${message}(${codes.join(', ')}).`;
}

export const itemNotFound = (itemCode: string): string =>
  withCodes('상세 코드를 찾을 수 없습니다', [itemCode]);

/** 삭제 확인 뒤 다른 관리자가 먼저 지워 지운 행 수가 모자랄 때 — 일부만 지우지 않고 되돌린다. */
export const DELETED_MEANWHILE =
  '다른 관리자가 먼저 지운 상세 코드가 있습니다. 다시 불러온 뒤 삭제해 주세요.';

/** 수정 확인 뒤 다른 관리자가 먼저 지운 행이 있을 때 — 지운 행에 쓰지 않고 되돌린다. */
export const deletedBeforeSave = (itemCode: string): string =>
  `다른 관리자가 먼저 지운 상세 코드가 있습니다(${itemCode}). 다시 불러온 뒤 저장해 주세요.`;

/**
 * 상세 코드 수정의 확인 — 고칠 행이 다 있고(없으면 404), 읽은 updatedAt 이 받은 값과 같은 ms 인가(아니면 409). 플랫폼 ·
 * BP 공통코드 관리가 함께 쓴다.
 */
export function assertItemsUnchanged(
  found: { itemCode: string; updatedAt: Date }[],
  items: UpdateCodeItemDto[],
): void {
  const byCode = new Map(found.map((r) => [r.itemCode, r.updatedAt]));
  const missing = items.find((u) => !byCode.has(u.itemCode));
  if (missing) throw new NotFoundException(itemNotFound(missing.itemCode));
  if (
    items.some((u) => !isSameMillisecond(byCode.get(u.itemCode)!, u.updatedAt))
  )
    throw new ConflictException(CHANGED_MEANWHILE);
}

/**
 * 같은 ms 조건의 수정이 0건일 때 — 그 사이 지웠으면 지운 문구, 살아 있으면 다른 관리자가 고친 것이다. 둘 다 409 로
 * 트랜잭션째 되돌린다.
 */
export async function throwUnsaved(
  tx: Prisma.TransactionClient,
  where: Prisma.CodeItemWhereInput & { itemCode: string },
): Promise<never> {
  const live = await tx.codeItem.findFirst({
    where,
    select: { itemCode: true },
  });
  throw new ConflictException(
    live ? CHANGED_MEANWHILE : deletedBeforeSave(where.itemCode),
  );
}

/** 한 요청 안에서 같은 코드가 두 번 오면(등록 · 수정 · 삭제 모두) 상세 코드 · 그룹 행을 읽기 전에 409. */
export function assertNoRepeat(codes: string[], message: string): void {
  const seen = new Set<string>();
  for (const code of codes) {
    if (seen.has(code)) throw new ConflictException(withCodes(message, [code]));
    seen.add(code);
  }
}

/** 요청한 코드 중 INSERT 가 돌려주지 않은 것 — 키가 겹쳐 건너뛰어진 코드다. 요청 순서대로. */
export function notCreated(requested: string[], created: string[]): string[] {
  const made = new Set(created);
  return requested.filter((code) => !made.has(code));
}
