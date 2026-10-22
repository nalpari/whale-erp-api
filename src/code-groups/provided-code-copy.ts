import type { Prisma, UseStatus } from '@prisma/client';
import {
  BP_ONLY_OWNER_CODE,
  PLATFORM_BP_CODE,
  PLATFORM_PROVIDED_OWNER_CODE,
} from './code-format';

/** 복사할 플랫폼 원본 상세 코드 한 행. */
export type ProvidedOriginal = {
  groupCode: string;
  itemCode: string;
  label: string;
  status: UseStatus;
  sortOrder: number;
};

/**
 * 플랫폼제공 그룹의 플랫폼 원본(BP000000) 상세 코드 — 지운 행 · BP전용 행은 빼고 사용중지는 넣는다(BP 가 처음 받는
 * 상태를 플랫폼과 같게 하고, 그 뒤 상태는 BP 가 바꾼다). groupCodes 를 주지 않으면 지우지 않은 플랫폼제공 그룹 전부다 —
 * 그룹의 적용 여부(is_bp_applied) · 사용 상태는 보지 않는다(회원가입).
 */
export async function providedOriginals(
  tx: Prisma.TransactionClient,
  groupCodes?: string[],
): Promise<ProvidedOriginal[]> {
  const codes =
    groupCodes ??
    (
      await tx.codeGroup.findMany({
        where: {
          manageOwnerCode: PLATFORM_PROVIDED_OWNER_CODE,
          isDeleted: false,
        },
        select: { groupCode: true },
      })
    ).map((g) => g.groupCode);
  if (!codes.length) return [];
  return tx.codeItem.findMany({
    where: {
      groupCode: { in: codes },
      bpCode: PLATFORM_BP_CODE,
      isDeleted: false,
      manageOwnerCode: { not: BP_ONLY_OWNER_CODE },
    },
    select: {
      groupCode: true,
      itemCode: true,
      label: true,
      status: true,
      sortOrder: true,
    },
    orderBy: [{ groupCode: 'asc' }, { sortOrder: 'asc' }, { itemCode: 'asc' }],
  });
}

/**
 * 원본을 BP 마다 플랫폼제공 행으로 넣는다 — [BP에 적용]과 회원가입이 함께 쓴다(플랫폼이 BP 를 직접 등록하는 경로가
 * 생기면 그것도). 키(그룹 · 상세 코드 · BP)가 이미 있는 행은 건너뛴다 — BP 가 고친 행 · BP전용 행을 덮어쓰거나
 * 되살리지 않는다. code_items 의 고유 제약은 PK 뿐이라 다른 위반이 조용히 건너뛰어지지는 않는다(고유 제약을 더하면
 * 다시 볼 것). 넣은 행 수를 돌려준다. 처리자(createdBy · updatedBy)는 그 동작을 한 관리자다.
 */
export async function copyProvidedItems(
  tx: Prisma.TransactionClient,
  originals: ProvidedOriginal[],
  bpCodes: string[],
  actorId: number,
): Promise<number> {
  if (!originals.length || !bpCodes.length) return 0;
  const { count } = await tx.codeItem.createMany({
    data: bpCodes.flatMap((bpCode) =>
      originals.map((o) => ({
        groupCode: o.groupCode,
        bpCode,
        itemCode: o.itemCode,
        label: o.label,
        status: o.status,
        sortOrder: o.sortOrder,
        manageOwnerCode: PLATFORM_PROVIDED_OWNER_CODE,
        createdBy: actorId,
        updatedBy: actorId,
      })),
    ),
    skipDuplicates: true,
  });
  return count;
}
