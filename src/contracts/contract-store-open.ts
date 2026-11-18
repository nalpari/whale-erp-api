import { ConflictException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { StoreStatus } from '../stores/store-format';

/**
 * 근무지 점포가 운영 중인가 — 운영(OPERATING) 점포에서만 근로계약서를 보내고 날인받는다(2026-11-18 김민식). 점포가 운영이
 * 되려면 사업자 인증 · 좌표 · BP 사용이 필요해(missingForOperation) 운영 점포에는 날인이 고정할 사용자 칸(대표자 ·
 * 사업자등록번호)이 늘 있다 — 본사는 사업자 인증을 풀면 미운영으로 내려간다. 미운영 · 폐점 · 삭제면 거짓이다.
 * 발송 · 날인 · 직원 앱 상세가 모두 이 판정을 쓴다(722 의 근무지 고르기와 같은 기준).
 */
export async function storeOperating(
  tx: Pick<Prisma.TransactionClient, 'store'>,
  storeId: number,
): Promise<boolean> {
  const store = await tx.store.findFirst({
    where: {
      storeId,
      isDeleted: false,
      storeStatusCode: 'OPERATING' satisfies StoreStatus,
    },
    select: { storeId: true },
  });
  return store !== null;
}

/**
 * storeOperating 과 같은 판정을 점포 행 공유 잠금(FOR SHARE)과 함께 — 날인이 고정할 사용자 칸을 읽기 전에 부른다. 본사 사업자
 * 인증 해제(사업자정보 비우기 + 미운영 전환, 한 트랜잭션 — syncHqStatus 가 본사 행을 FOR NO KEY UPDATE 로 잡는다)와 줄을
 * 세워, 운영으로 판정한 뒤 빈 사용자 칸을 읽어 고정하는 틈을 없앤다. 점포 행이 없으면 거짓이다.
 */
export async function lockStoreOperating(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  storeId: number,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ operating: boolean }[]>`
    SELECT ("store_status_code" = 'OPERATING' AND NOT "is_deleted") AS "operating"
    FROM "stores" WHERE "store_id" = ${storeId} FOR SHARE`;
  return rows[0]?.operating === true;
}

/** 근무지 행으로 본 운영 여부 — 직원 앱 상세처럼 점포를 이미 읽은 곳에서 storeOperating 과 같은 판정을 한다 */
export const isOperatingStore = (store: {
  storeStatusCode: string;
  isDeleted: boolean;
}): boolean =>
  store.storeStatusCode === ('OPERATING' satisfies StoreStatus) &&
  !store.isDeleted;

/** 운영 중이 아닌 근무지라 막을 때의 409 — 관리자(발송)와 직원(날인)에게 다른 문장을 보인다 */
export const storeNotOperatingConflict = (message: string) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'STORE_NOT_OPERATING',
    message,
  });
