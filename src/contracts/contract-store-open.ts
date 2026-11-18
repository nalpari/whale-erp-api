import {
  ConflictException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { StoreStatus } from '../stores/store-format';

/** 근무지가 운영 중인지 보는 데 읽는 점포 칸 — 상태 · 지움과 사용자 칸(대표자 · 사업자등록번호) */
export const STORE_OPEN_SELECT = {
  storeStatusCode: true,
  isDeleted: true,
  businessProfile: {
    select: { bizCeoName: true, bizRegistrationNumber: true },
  },
} satisfies Prisma.StoreSelect;

/**
 * 근무지 점포가 운영 중인가 — 운영(OPERATING)이고 지우지 않았고 날인이 고정할 사용자 칸(대표자 · 사업자등록번호, 공백만 있으면
 * 빈 값)이 있어야 근로계약서를 보내고 날인받는다(2026-11-18 김민식). 「사업주 정보가 없는 점포는 미운영으로 본다」(사용자 결정)
 * — 점포는 사업자 인증 · 좌표 · BP 사용이 있어야 운영이 되고(missingForOperation) 본사는 인증을 풀면 미운영으로 내려가지만,
 * 그 규칙 전에 인증 없이 운영으로 들어온 점포가 남아 있어 사용자 칸도 함께 본다. 발송 · 날인 · 직원 앱 상세가 모두 이 판정을
 * 쓴다(722 의 근무지 고르기와 같은 운영 기준).
 */
export const isOperatingStore = (store: {
  storeStatusCode: string;
  isDeleted: boolean;
  businessProfile: {
    bizCeoName: string | null;
    bizRegistrationNumber: string | null;
  } | null;
}): boolean =>
  store.storeStatusCode === ('OPERATING' satisfies StoreStatus) &&
  !store.isDeleted &&
  Boolean(store.businessProfile?.bizCeoName?.trim()) &&
  Boolean(store.businessProfile?.bizRegistrationNumber?.trim());

/** isOperatingStore 를 점포 id 로 — 잠그지 않고 읽는다(발송 · 날인 올리기 전). 점포가 없으면 거짓 */
export async function storeOperating(
  tx: Pick<Prisma.TransactionClient, 'store'>,
  storeId: number,
): Promise<boolean> {
  const store = await tx.store.findFirst({
    where: { storeId },
    select: STORE_OPEN_SELECT,
  });
  return store !== null && isOperatingStore(store);
}

/**
 * 점포 행 공유 잠금(FOR SHARE) — 날인이 판정 · 고정할 점포 칸을 읽기 전에 부른다. 본사 사업자 인증 해제(사업자정보 비우기 +
 * 미운영 전환, 한 트랜잭션 — syncHqStatus 가 본사 행을 FOR NO KEY UPDATE 로 잡는다)와 줄을 세워, 판정한 값과 고정하는 값이
 * 같은 시점이 되게 한다. 점포 행이 없으면 500(데이터 깨짐 — 계약의 외래키라 늘 있다).
 */
export async function lockStore(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  storeId: number,
): Promise<void> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM "stores" WHERE "store_id" = ${storeId} FOR SHARE`;
  if (!rows.length)
    throw new InternalServerErrorException(
      `점포 ${storeId} 를 찾을 수 없습니다.`,
    );
}

/** 운영 중이 아닌 근무지라 막을 때의 409 — 관리자(발송)와 직원(날인)에게 다른 문장을 보인다 */
export const storeNotOperatingConflict = (message: string) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'STORE_NOT_OPERATING',
    message,
  });
