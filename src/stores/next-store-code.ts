import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * 점포 채번 트랜잭션 시간 — 모든 등록이 점포코드 잠금에 줄을 서므로 기본값(대기 2초 · 실행 5초)보다 넉넉히 둔다.
 * 점포 등록과 본사 점포 생성이 함께 쓴다.
 */
export const STORE_CODE_TX = { maxWait: 5_000, timeout: 15_000 };

/** 다음 점포코드. 6자리를 다 쓰면 더 만들 수 없다. */
export function nextStoreCode(last: string | null): string {
  const next = (last ? Number(last.slice(2)) : 0) + 1;
  if (next > 999_999)
    throw new ConflictException('점포코드를 더 만들 수 없습니다.');
  return `ST${String(next).padStart(6, '0')}`;
}

/**
 * 트랜잭션 안에서 점포코드 잠금을 잡고 다음 번호를 정한다 — 점포 등록과 본사 점포 생성이 같은 잠금을 써야 번호가
 * 겹치지 않는다. 잠금은 트랜잭션이 끝날 때 풀린다.
 */
export async function claimStoreCode(
  tx: Pick<Prisma.TransactionClient, '$executeRaw' | 'store'>,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('stores:store_code'))`;
  const last = await tx.store.findFirst({
    orderBy: { storeCode: 'desc' },
    select: { storeCode: true },
  });
  return nextStoreCode(last?.storeCode ?? null);
}
