import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
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
/** 404 는 문구 끝에 점포 id 를 괄호로 붙인다 — 행이 없을 수 있어 이름을 못 쓴다. 3팀 확인의 404 와 같은 모양 */
const NOT_FOUND = '점포를 찾을 수 없습니다.';
/** 409 는 문구 끝에 점포명을 괄호로 붙인다 — 화면에 그대로 나오는데 내부 id 는 고객이 알 수 없다(2026-11-09) */
const ALREADY_CLOSED = '이미 폐점한 점포입니다.';
/**
 * 폐점의 열린 출근 409 문구 — 3팀 문구는 가장 이른 열린 출근의 날짜 · 시각을 싣는데, 점포 전체에서 고르므로 본사에게 가려지는
 * 직원(hiddenCount)의 출근일 수 있다. 확인이 건수만 내보내듯 저장의 409 도 시각을 빼고 막힘만 알린다(2026-11-04, front 요청).
 * 할 일 안내(「출퇴근 현황에서 보정」)도 싣지 않는다 — 가려진 직원의 출근은 출퇴근 현황에도 보이지 않아 따를 수 없는 경우가 있다.
 * 막힘 이름은 front 폐점 팝업과 같은 「퇴근 기록이 없는 출근」이다(2026-11-05, front PR #222).
 */
const OPEN_CHECK_IN_MESSAGE =
  '퇴근 기록이 없는 출근이 있어 폐점할 수 없습니다.';
/** 교착이 두 번 나면 — 모두 되돌아갔으므로 다시 하면 된다는 것을 알린다(500 이 아니라 409) */
const BUSY =
  '다른 처리와 겹쳐 폐점하지 못했습니다. 바뀐 것은 없으니 잠시 뒤 다시 시도해 주세요.';

const logger = new Logger('StoreClosings');

/**
 * 폐점 트랜잭션의 제한 시간. 직원이 많은 점포(또는 회원 탈퇴의 여러 점포)는 3팀 일괄 퇴직이 Prisma 기본 5초를 넘긴다
 * (okf/api/staff-retirement.md 「1팀이 정할 것」 3). 부르는 쪽이 `$transaction` 옵션에 쓴다.
 */
export const STORE_CLOSING_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * 점포 폐점(확인 · 저장) — 점포 폐점(`PUT /stores/:id`)이 쓰고, 회원 탈퇴 · BP 탈퇴가 같이 쓸 예정이다(아직 연결 전). 업무 범위 · 권한 · BP 상태 판단은
 * 부르는 쪽이 하고, 여기서는 받은 점포 id 만 다룬다. 결과에는 점포마다 점포명 · 점포코드를 붙여 부르는 쪽이 그대로 내보낼 수
 * 있게 한다. 3팀 `storeClosingCheck` · `RetirementService.retireStores`(여러 점포 버전)를 감싼다.
 */
@Injectable()
export class StoreClosingsService {
  constructor(private readonly retirement: RetirementService) {}

  /**
   * 폐점 확인 — 읽기 전용, 잠그지 않는다. 막힘은 퇴근하지 않은 출근(이름이 보이는 것 + 가려지는 것)이 있을 때다. 열린 출근은
   * 수만 내보내고 3팀 결과의 첫 건(직원 이름 · 시각)은 버린다.
   * 대기 계약 · 퇴직될 직원 · 확정하지 않은 급여명세서는 막지 않고 알리기만 한다(폐점이 닫거나, 폐점 뒤에도 처리할 수 있다).
   * 없거나 지운 점포가 섞이면 404(3팀 확인이 던진다).
   */
  async check(
    client: Tx,
    storeIds: number[],
    now: Date = new Date(),
  ): Promise<StoreClosingCheckResponseDto> {
    const ids = sortedUnique(storeIds);
    // 차례로 묻는다 — 3팀 확인이 먼저 없거나 지운 점포를 404 로 거르므로, 뒤의 이름 조회는 모든 id 를 찾는다.
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
      stores: result.stores.map(({ storeId, ...counts }) => {
        // 3팀 확인이 404 로 거른 뒤라 늘 있다 — 없으면 빈 이름으로 숨기지 않고 계약이 깨진 것을 드러낸다.
        const store = nameOf.get(storeId);
        if (!store) throw contractBroken('점포명', storeId);
        return {
          storeId,
          storeName: store.name,
          storeCode: store.storeCode,
          ...withBlocked(counts),
        };
      }),
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
   *    초대 만료를 한다. 예외는 그대로 던져 트랜잭션째 되돌린다 — 열린 출근 409 만 code · storeId 를 두고 문구에서 출근 시각을 뺀다.
   * 3. 점포를 폐점 · 폐점일(한국 날짜 오늘)로 바꾸고 점포마다 점포상태 이력을 남긴다.
   *
   * 저장 때는 `check` 를 다시 부르지 않는다 — 막힘(열린 출근)은 `retireStores` 가 직원을 잠근 뒤 다시 보고 409 로 되돌린다.
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
    const liveIds = new Set(live.map((s) => s.storeId));
    const missing = ids.filter((id) => !liveIds.has(id));
    if (missing.length)
      throw new NotFoundException(`${NOT_FOUND} (${missing.join(', ')})`);
    const closed = live.filter((s) => s.storeStatusCode === CLOSED);
    if (closed.length)
      throw new ConflictException(
        `${ALREADY_CLOSED} (${closed.map((s) => s.name).join(', ')})`,
      );

    const closedDate = kstToday(now);
    const { byStore, total } = await this.retirement
      .retireStores(tx, ids, closedDate, adminAccountId, now)
      .catch((error: unknown) => {
        throw withoutCheckInTime(error);
      });

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
      stores: live.map((s) => {
        // 3팀이 넘긴 id 마다 0 칸이라도 채운다 — 없으면 「처리 0건」으로 숨기지 않는다(그 결과를 사용자에게 안내한다).
        const done = byStore[s.storeId];
        if (!done) throw contractBroken('처리 결과', s.storeId);
        return {
          storeId: s.storeId,
          storeName: s.name,
          storeCode: s.storeCode,
          ...done,
        };
      }),
      total,
    };
  }
}

/**
 * 교착이면 한 번 다시 한다 — 폐점은 점포 → 직원 → 계정 순으로 잠그는데, 반대 순서로 잠그는 경로가 남아 있다: 계약 재발송(직원 →
 * 점포 `FOR SHARE`), 근무지 추가 · 소속 추가 확인 수락(계정 → 직원). 엇갈리면 PostgreSQL 이 한쪽을 되돌린다(okf/api/staff-retirement.md
 * 「1팀이 정할 것」 2). 되돌린 쪽은 아무것도 남기지 않았으므로 처음부터 다시 해도 된다. 첫 교착은 경고로 남기고(얼마나 부딪히는지 보려고),
 * 두 번째도 교착이면 409 로 「바뀐 것 없음 · 다시 시도」를 알린다 — 그대로 두면 설명 없는 500 이다. 교착이 아닌 오류는 그대로 던진다.
 *
 * @param run 트랜잭션을 처음부터 여는 함수여야 한다(`() => prisma.$transaction(...)`). 바깥 트랜잭션 안에서 부르면 교착으로 이미
 *   중단된 트랜잭션에서 다시 실행하게 되어 다시 하는 의미가 없다.
 * @param label 경고에 남길 대상(예: 점포 id)
 */
export async function retryOnDeadlock<T>(
  run: () => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    logger.warn(`폐점 교착 — 한 번 다시 한다 (${label}): ${error.message}`);
  }
  try {
    return await run();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    logger.warn(`폐점 교착 — 다시 해도 겹쳐 409 (${label}): ${error.message}`);
    throw new ConflictException(BUSY);
  }
}

/**
 * 교착 · 쓰기 충돌인가. 일반 쿼리는 P2034 — adapter-pg 가 SQLSTATE 40P01(교착)과 40001(직렬화 실패)을 TransactionWriteConflict
 * 로 바꾼다. READ COMMITTED 라 실제로는 교착이다. 원시 쿼리(점포 · 직원 · 계정 잠금)는 P2010 이고 메시지에
 * 「Raw query failed. Code: `40P01`」로 실린다. meta 는 Error 객체를 담아 직렬화하다 다른 오류가 날 수 있어 보지 않는다.
 */
function isDeadlock(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return (
    error.code === 'P2034' ||
    (error.code === 'P2010' && error.message.includes('Code: `40P01`'))
  );
}

/**
 * 3팀의 열린 출근 409 에서 문구만 바꾼다(code · storeId · 상태는 그대로). 다른 오류는 그대로 돌려준다.
 */
function withoutCheckInTime(error: unknown): unknown {
  if (!(error instanceof ConflictException)) return error;
  const body = error.getResponse();
  if (
    typeof body !== 'object' ||
    (body as { code?: unknown }).code !== 'OPEN_CHECK_IN'
  )
    return error;
  return new ConflictException({ ...body, message: OPEN_CHECK_IN_MESSAGE });
}

/**
 * 3팀 함수가 약속을 어겼다 — 그럴듯한 빈 값 대신 500 으로 드러낸다. Nest 기본 필터는 HttpException 을 로그로 남기지 않으므로
 * 던지기 전에 오류 로그를 남긴다(그래야 서버 쪽에서 원인을 찾는다).
 */
function contractBroken(what: string, storeId: number) {
  const message = `폐점 ${what}에 점포 ${storeId} 가 없습니다.`;
  logger.error(`3팀 계약 위반 — ${message}`);
  return new InternalServerErrorException(message);
}

/** 3팀 수에 막힘을 붙인다. 열린 출근은 수만 남기고 첫 건(직원 이름 · 시각)은 버린다 — StoreClosingOpenCheckInsDto */
function withBlocked({
  openCheckIns: { count, hiddenCount },
  ...rest
}: StoreClosingCounts): StoreClosingCountsDto {
  return {
    ...rest,
    openCheckIns: { count, hiddenCount },
    isBlocked: count + hiddenCount > 0,
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
