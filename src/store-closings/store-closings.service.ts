import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { kstToday } from '../staff-members/kst-date';
import { RetirementService } from '../staff-members/retirement.service';
import {
  type StoreClosingCounts,
  storeClosingCheck,
} from '../staff-members/store-closing-check';
import { retainEndDate, statusLabel } from '../stores/store-format';
import type {
  StoreClosingCheckResponseDto,
  StoreClosingCountsDto,
  StoreClosingResultResponseDto,
} from './dto/store-closing.response.dto';

type Tx = Prisma.TransactionClient;

const CLOSED = 'CLOSED';
const NOT_FOUND = '점포를 찾을 수 없습니다';
const ALREADY_CLOSED = '이미 폐점한 점포입니다.';

/**
 * 폐점 트랜잭션의 제한 시간. 직원이 많은 점포(또는 회원 탈퇴의 여러 점포)는 3팀 일괄 퇴직이 Prisma 기본 5초를 넘긴다
 * (okf/api/staff-retirement.md 「1팀이 정할 것」 3). 부르는 쪽이 `$transaction` 옵션에 쓴다.
 */
export const STORE_CLOSING_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * 점포 폐점(확인 · 저장) — 점포 폐점(`PUT /stores/:id`) · 회원 탈퇴 · BP 탈퇴가 같이 쓴다. 업무 범위 · 권한 · BP 상태 판단은
 * 부르는 쪽이 하고, 여기서는 받은 점포 id 만 다룬다. 결과에는 점포마다 점포명 · 점포코드를 붙여 부르는 쪽이 그대로 내보낼 수
 * 있게 한다. 3팀 `storeClosingCheck` · `RetirementService.retireStores`(여러 점포 버전)를 감싼다.
 */
@Injectable()
export class StoreClosingsService {
  constructor(private readonly retirement: RetirementService) {}

  /**
   * 폐점 확인 — 읽기 전용, 잠그지 않는다. 막힘은 퇴근하지 않은 출근(이름을 내보내는 것 + 가려지는 것)이 있을 때다.
   * 대기 계약 · 퇴직될 직원 · 확정하지 않은 급여명세서는 막지 않고 알리기만 한다(폐점이 닫거나, 폐점 뒤에도 처리할 수 있다).
   * 없거나 지운 점포가 섞이면 404(3팀 확인이 던진다).
   */
  async check(
    client: Tx,
    storeIds: number[],
    now: Date = new Date(),
  ): Promise<StoreClosingCheckResponseDto> {
    const ids = sortedUnique(storeIds);
    // 차례로 묻는다 — 3팀 확인이 먼저 없거나 지운 점포를 404 로 거른다(e2e 의 PGlite 는 연결을 하나만 받는다).
    const result = await storeClosingCheck(client, ids, kstToday(now), now);
    const names = ids.length
      ? await client.store.findMany({
          where: { storeId: { in: ids } },
          select: { storeId: true, name: true, storeCode: true },
        })
      : [];
    const nameOf = new Map(names.map((s) => [s.storeId, s]));
    const total = withBlocked(result.total);
    return {
      stores: result.stores.map(({ storeId, ...counts }) => ({
        storeId,
        storeName: nameOf.get(storeId)?.name ?? '',
        storeCode: nameOf.get(storeId)?.storeCode ?? '',
        ...withBlocked(counts),
      })),
      total,
      isBlocked: total.isBlocked,
    };
  }

  /**
   * 폐점 저장 — 부르는 쪽의 트랜잭션(`tx`) 안에서 부른다. 부르는 쪽이 먼저 잠가도 되는 것은 그 점포 행(과 점포에 딸린 행)까지다 —
   * 직원 · 계정 행을 먼저 잡으면 3팀의 점포 → 직원 → 계정 순서가 뒤집힌다. 순서:
   * 1. 점포 행을 모두 id 오름차순으로 `FOR NO KEY UPDATE` 로 잠근다 — `FOR UPDATE` 면 출퇴근 · 근무스케줄 · TO-DO 의 외래키
   *    잠금(`FOR KEY SHARE`)과 부딪쳐 교착할 수 있다(okf/api/staff-retirement.md 「1팀이 정할 것」 1). 지웠거나 없으면 404,
   *    이미 폐점이면 409.
   * 2. 3팀 `retireStores` — 잠근 뒤 열린 출근을 다시 보고(있으면 409 `OPEN_CHECK_IN` + storeId), 직원 퇴직일 · 대기 계약 종료 ·
   *    초대 만료를 한다. 예외는 그대로 던져 트랜잭션째 되돌린다.
   * 3. 점포를 폐점 · 폐점일(한국 날짜 오늘)로 바꾸고 점포마다 점포상태 이력을 남긴다.
   *
   * 트랜잭션 제한 시간은 `STORE_CLOSING_TRANSACTION_TIMEOUT_MS`, 교착 재시도는 `retryOnDeadlock` 으로 부르는 쪽이 정한다.
   */
  async close(
    tx: Tx,
    storeIds: number[],
    adminAccountId: number,
    now: Date = new Date(),
  ): Promise<StoreClosingResultResponseDto> {
    const ids = sortedUnique(storeIds);
    if (ids.length === 0) return { stores: [], total: emptyRetirement() };

    const locked = await tx.$queryRaw<
      {
        storeId: number;
        name: string;
        storeCode: string;
        storeStatusCode: string;
        isDeleted: boolean;
      }[]
    >`SELECT store_id AS "storeId", name, store_code AS "storeCode", store_status_code AS "storeStatusCode", is_deleted AS "isDeleted" FROM stores WHERE store_id IN (${Prisma.join(ids)}) ORDER BY store_id FOR NO KEY UPDATE`;
    const live = locked.filter((s) => !s.isDeleted);
    if (live.length !== ids.length) throw new NotFoundException(NOT_FOUND);
    if (live.some((s) => s.storeStatusCode === CLOSED))
      throw new ConflictException(ALREADY_CLOSED);

    const closedDate = kstToday(now);
    const { byStore, total } = await this.retirement.retireStores(
      tx,
      ids,
      closedDate,
      adminAccountId,
      now,
    );

    await tx.store.updateMany({
      where: { storeId: { in: ids } },
      data: {
        storeStatusCode: CLOSED,
        closedDate,
        updatedBy: adminAccountId,
      },
    });
    const retainUntil = retainEndDate(now);
    await tx.storeChangeHistory.createMany({
      data: live.map((s) => ({
        storeId: s.storeId,
        field: '점포상태',
        beforeValue: statusLabel(s.storeStatusCode),
        afterValue: statusLabel(CLOSED),
        changedBy: adminAccountId,
        changedAt: now,
        retainEndDate: retainUntil,
      })),
    });

    return {
      stores: live.map((s) => ({
        storeId: s.storeId,
        storeName: s.name,
        storeCode: s.storeCode,
        ...(byStore[s.storeId] ?? emptyRetirement()),
      })),
      total,
    };
  }
}

/**
 * 교착(40P01)이면 한 번 다시 한다 — 폐점의 점포 → 직원 → 계정 순서와 계약 재발송(직원 → 점포) 등 반대 순서 경로가 엇갈리면
 * PostgreSQL 이 한쪽을 되돌린다(okf/api/staff-retirement.md 「1팀이 정할 것」 2). 되돌린 쪽은 아무것도 남기지 않았으므로 처음부터
 * 다시 해도 된다. 두 번째도 교착이면 그 오류를 던진다.
 */
export async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    return run();
  }
}

function isDeadlock(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  // 일반 쿼리는 P2034(adapter-pg 가 40P01 을 TransactionWriteConflict 로 바꾼다), 원시 쿼리는 P2010 의 메시지에
  // 「Raw query failed. Code: `40P01`」로 실린다. meta 는 Error 객체를 담아 직렬화하다 다른 오류가 날 수 있어 보지 않는다.
  return error.code === 'P2034' || error.message.includes('40P01');
}

function withBlocked(counts: StoreClosingCounts): StoreClosingCountsDto {
  return {
    ...counts,
    isBlocked: counts.openCheckIns.count + counts.openCheckIns.hiddenCount > 0,
  };
}

function sortedUnique(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function emptyRetirement() {
  return {
    retiringStaff: 0,
    pulledForwardStaff: 0,
    draftContracts: 0,
    pendingSendContracts: 0,
    pendingSignatureContracts: 0,
    expiredInvitations: 0,
  };
}
