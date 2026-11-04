import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma, StatusChangeActor } from '@prisma/client';
import { refillHiredDate } from '../contracts/contract-status';
import { PrismaService } from '../prisma/prisma.service';
import { RetirementPreviewResponseDto } from './dto/retirement-preview.response.dto';
import { addDays, addMonths, kstDayStart, kstToday } from './kst-date';
import { SIGNED_ONCE } from '../contracts/signed-contract';
import { editableStart } from '../attendance/attendance-rules';
import { kstTimeOf } from '../work-schedules/work-schedule-rules';

/**
 * 퇴직이 확정될 때 종료로 닫는 계약 상태 — 아직 체결되지 않은 절차. 임시저장도 닫는다: 남겨 두면 나중에 이어 써서
 * 퇴직자에게 근로계약서가 갈 수 있다 (2026-10-12 재영).
 */
export const PENDING_CONTRACT_STATUSES: ContractStatus[] = [
  'DRAFT',
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
];

/** 지난 날짜로 처리할 수 있는 한도. 그보다 오래된 퇴직은 받지 않는다. */
const MAX_PAST_MONTHS = 3;

type Tx = Prisma.TransactionClient;

/** `retireStore` 의 반환값 — 1팀이 폐점 결과 안내와 점포 변경 이력에 쓴다 (폐점 확인 서비스와 같은 이름 · 뜻). */
export interface StoreClosingRetirementResult {
  /**
   * 퇴직될 직원 수 — 폐점 확인 서비스(647)의 퇴직될 직원과 같은 기준. 임시저장만 있던 가입 전 레코드는 퇴직일을 정하지만
   * 세지 않는다(`draftContracts` 로 드러남)
   */
  retiringStaff: number;
  /** 퇴직일을 폐점일로 당긴 수 */
  pulledForwardStaff: number;
  /** 종료로 닫은 임시저장 계약 수 */
  draftContracts: number;
  /** 종료로 닫은 발송 대기 계약 수 */
  pendingSendContracts: number;
  /** 종료로 닫은 서명 대기 + 수정 요청 계약 수 */
  pendingSignatureContracts: number;
  /** 만료로 바꾼 발송(SENT) 초대 수 */
  expiredInvitations: number;
}

/** `retireStores` 의 반환값 — 넘긴 점포마다의 결과와 합계. */
export interface StoresClosingRetirementResult {
  /** 넘긴 점포 id 마다 (직원이 없어도 0 칸으로) */
  byStore: Record<number, StoreClosingRetirementResult>;
  /** 점포별 결과의 합계 */
  total: StoreClosingRetirementResult;
}

const emptyResult = (): StoreClosingRetirementResult => ({
  retiringStaff: 0,
  pulledForwardStaff: 0,
  draftContracts: 0,
  pendingSendContracts: 0,
  pendingSignatureContracts: 0,
  expiredInvitations: 0,
});

/** 퇴직을 확정하는 쪽. 배치면 SYSTEM, 지난 날짜로 바로 처리하면 그 관리자다. */
type Finalizer =
  { actor: 'SYSTEM' } | { actor: 'ADMIN'; adminAccountId: number };

/**
 * 직원 퇴직 처리 (WHALEERP-583 · 584). 근로계약은 계약대로 두고 퇴직은 따로 본다(2026-10-07 협의).
 *
 * 처리 · 취소 · 퇴직일 변경은 퇴직일과 로그만 바꾼다. 재직 상태를 퇴직으로 바꾸고 스케줄 · 개인 TO-DO 배정 ·
 * 대기 계약을 정리하는 것은 퇴직일 다음 날 배치(`retireDue`)다 — 그래서 취소 · 변경에 되돌릴 데이터가 없다.
 * 지난 날짜로 처리하면 배치를 기다리지 않고 그 자리에서 같은 정리를 한다.
 *
 * 처리 · 취소 · 변경은 직원 레코드 행을 잠그고 판단한다. 같은 직원에 대한 요청이 겹쳐도 하나씩 지나가고,
 * 배치와 겹쳐도 배치의 조건부 갱신이 잠금 뒤의 값을 본다.
 */
@Injectable()
export class RetirementService {
  private readonly logger = new Logger(RetirementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 확인창용. 처리 · 변경이 함께 쓰는 날짜 · 상태 검사(재직으로 세는 레코드 · 아직 퇴직 전 · 날짜 범위 · 입사일)만 한다.
   * 처리 · 변경 고유의 검사(이미 퇴직 예정인지, 퇴직일 전날까지인지)는 하지 않는다 — 퇴직일 변경 확인창도
   * 이 미리 보기를 쓰기 때문이다.
   */
  async preview(
    staffMemberId: number,
    retiredDate: Date,
    now: Date = new Date(),
  ): Promise<RetirementPreviewResponseDto> {
    const staff = await this.findStaff(this.prisma, staffMemberId);
    await this.assertCanRetire(this.prisma, staffMemberId, staff);
    this.assertDateAllowed(retiredDate, kstToday(now), staff.hiredDate);
    const [schedulesToRemove, todosToUnassign, contractsToEnd] =
      await Promise.all([
        this.prisma.workSchedule.count({
          where: this.schedulesAfter(staffMemberId, retiredDate),
        }),
        this.prisma.todoAssignee.count({
          where: this.openPersonalAssignments(staffMemberId),
        }),
        this.prisma.contract.findMany({
          where: {
            staffMemberId,
            status: { in: PENDING_CONTRACT_STATUSES },
          },
          select: { contractId: true, status: true },
          orderBy: { contractId: 'asc' },
        }),
      ]);
    return {
      schedulesToRemove,
      todosToUnassign,
      // 계약 상태는 임시저장 때문에 NULL 을 허용한다. 위 조건이 대기 상태만 고르므로 NULL 은 오지 않는다.
      contractsToEnd: contractsToEnd.flatMap(({ contractId, status }) =>
        status ? [{ contractId, status }] : [],
      ),
    };
  }

  async retire(
    adminAccountId: number,
    staffMemberId: number,
    retiredDate: Date,
    now: Date = new Date(),
  ): Promise<void> {
    const today = kstToday(now);
    await this.prisma.$transaction(async (tx) => {
      const staff = await this.lockStaff(tx, staffMemberId);
      await this.assertCanRetire(tx, staffMemberId, staff);
      if (staff.retiredDate !== null)
        throw new ConflictException(
          '이미 퇴직 예정입니다. 퇴직일을 바꾸려면 퇴직일 변경을 써 주세요.',
        );
      this.assertDateAllowed(retiredDate, today, staff.hiredDate);
      await assertNoOpenCheckIn(tx, staffMemberId);

      await this.schedule(tx, adminAccountId, staffMemberId, retiredDate, now);
      await this.finalizeIfPast(
        tx,
        adminAccountId,
        staffMemberId,
        retiredDate,
        today,
      );
    });
  }

  /**
   * 퇴직일 변경. 이력은 CANCEL(옛 날짜) + RETIRE(새 날짜) 두 줄이고 처리 시각이 같다. 「변경」과 「취소 후
   * 다시 처리」를 따로 구분하지 않는다 — 결과가 같고, 구분이 필요해지면 CHANGE 동작을 더한다.
   */
  async changeDate(
    adminAccountId: number,
    staffMemberId: number,
    retiredDate: Date,
    now: Date = new Date(),
  ): Promise<void> {
    const today = kstToday(now);
    await this.prisma.$transaction(async (tx) => {
      const { retiredDate: current, hiredDate } = await this.lockScheduled(
        tx,
        staffMemberId,
        today,
      );
      if (current.getTime() === retiredDate.getTime())
        throw new ConflictException('지금 퇴직일과 같습니다.');
      this.assertDateAllowed(retiredDate, today, hiredDate);
      await assertNoOpenCheckIn(tx, staffMemberId);
      await tx.staffMemberRetirementLog.create({
        data: {
          staffMemberId,
          action: 'CANCEL',
          retiredDate: current,
          processedBy: adminAccountId,
          processedAt: now,
        },
      });
      await this.schedule(tx, adminAccountId, staffMemberId, retiredDate, now);
      // 퇴직일을 미뤄 앞서 건너뛴 계약이 들어오면 입사일을 채운다(api #124 리뷰)
      if (hiredDate === null)
        await refillHiredDate(tx, staffMemberId, retiredDate);
      await this.finalizeIfPast(
        tx,
        adminAccountId,
        staffMemberId,
        retiredDate,
        today,
      );
    });
  }

  async cancel(
    adminAccountId: number,
    staffMemberId: number,
    now: Date = new Date(),
  ): Promise<void> {
    const today = kstToday(now);
    await this.prisma.$transaction(async (tx) => {
      const { retiredDate: current, hiredDate } = await this.lockScheduled(
        tx,
        staffMemberId,
        today,
      );
      await tx.staffMember.update({
        where: { staffMemberId },
        data: { retiredDate: null },
      });
      // 퇴직일 때문에 건너뛴 계약이 있으면 입사일을 채운다(api #124 리뷰)
      if (hiredDate === null) await refillHiredDate(tx, staffMemberId, null);
      await tx.staffMemberRetirementLog.create({
        data: {
          staffMemberId,
          action: 'CANCEL',
          retiredDate: current,
          processedBy: adminAccountId,
          processedAt: now,
        },
      });
    });
  }

  /**
   * 퇴직일이 지난(`retired_date < 오늘`) 재직 레코드를 퇴직으로 바꾸고 정리한다. 배치가 부른다.
   * `=` 가 아니라 `<` 다 — 하루 실패해도 다음 실행이 밀린 것까지 잡는다. 퇴직으로 바꾸는 갱신이
   * 조건부라, 두 번 돌거나 겹쳐 돌아도 같은 레코드를 두 번 정리하지 않는다.
   *
   * **직원마다 트랜잭션을 따로 연다.** 받은 `tx`(배치 락의 트랜잭션)로는 대상을 고르기만 한다. 전부를 한
   * 트랜잭션에 넣으면 한 명의 실패가 그날 밤 전원을 롤백하고, 원인 레코드가 남아 있으면 매일 같은 자리에서
   * 실패해 다른 직원의 퇴직까지 막는다(PR #8 팀 리뷰). 배치 락은 이 함수가 끝날 때까지 잡혀 있으므로
   * 겹쳐 도는 실행은 여전히 막힌다. `BatchLockService` 의 「`tx` 로만 쓴다」 규칙에서 일부러 벗어난 것이다.
   *
   * 실패한 직원은 확정 전 그대로 남기고(퇴직인데 스케줄이 남는 반쪽 상태를 만들지 않는다) 직원 ID 와 함께
   * 남긴다. 다음 실행이 다시 시도한다.
   * @returns 이번에 퇴직으로 바꾼 레코드 수
   */
  async retireDue(tx: Tx, today: Date): Promise<number> {
    const due = await tx.staffMember.findMany({
      where: { employmentStatus: 'EMPLOYED', retiredDate: { lt: today } },
      select: { staffMemberId: true, retiredDate: true },
      orderBy: { staffMemberId: 'asc' },
    });
    let retired = 0;
    for (const { staffMemberId, retiredDate } of due) {
      if (!retiredDate) continue;
      try {
        if (
          await this.prisma.$transaction((own) =>
            this.finalize(own, staffMemberId, retiredDate, { actor: 'SYSTEM' }),
          )
        )
          retired += 1;
      } catch (error) {
        this.logger.error(
          `퇴직 확정 실패 staffMemberId=${staffMemberId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return retired;
  }

  /**
   * 점포 폐점 순간의 퇴직 처리 (WHALEERP-648, 운영 정책 CTR-31). 1팀 폐점 api(`PUT /stores/:id`)가 **점포 행을 `FOR UPDATE` 로
   * 잡고 CLOSED 로 바꾸는 트랜잭션 안에서** 부른다 — 예외는 삼키지 않으니 하나라도 실패하면 폐점째 되돌아간다.
   * 직원 알림은 보내지 않는다. `closedDate` 는 한국 날짜(00:00Z date-only)로 맞춰 쓴다 — 시각이 섞여 와도 된다.
   *
   * 잠금 순서는 점포(1팀이 먼저) → 직원 → 계정이다. 그 점포의 재직(EMPLOYED) 직원 행을 `staff_member_id` 오름차순으로
   * `FOR NO KEY UPDATE`, 그 직원들의 계정 행(중복 제거)을 `account_id` 오름차순으로 `FOR UPDATE` — `lockStaff` 의 직원 → 계정
   * 순서를 따른다. 잠근 뒤 재직 레코드 전체의 열린 출근을 한 번의 쿼리로(`assertNoOpenCheckIn`, 퇴직 처리와 같은 기준) 보고 하나라도 있으면 가장 이른 것으로
   * 409 `OPEN_CHECK_IN` 으로 트랜잭션째 되돌린다.
   *
   * 폐점 순간 이 메소드가 하는 것:
   * - 그 점포(`contracts.store_id`)의 대기 계약 4종(임시저장 · 발송 대기 · 서명 대기 · 수정 요청)을 종료로 닫고 상태 이력(ADMIN)을
   *   남긴다. 「임시저장 계약만 있는 가입 전 레코드」의 임시저장도 함께 닫힌다(그 레코드도 아래에서 퇴직일이 정해진다).
   * - 그 점포 직원 레코드에 나간 `SENT` 초대는 종류 구분 없이 모두 만료로 바꾼다.
   * - 퇴직 대상(그 점포의 재직 레코드 전부 — 임시저장만 있던 가입 전 레코드도 포함: 그 임시저장이 위에서 닫혀 재직으로 세지므로)의 퇴직일을 정한다. 퇴직일 없음 → 폐점일(`schedule`:
   *   RETIRE 로그 · 걸친 체결 계약 행). 폐점일보다 뒤 → 폐점일로 당김(CANCEL 옛 날짜 + RETIRE 폐점일, 처리 시각 같음).
   *   폐점일 이전 또는 같은 날 → 그대로(로그 없음). 입사일이 폐점일 뒤여도 폐점일로 정한다(막지 않음).
   *
   * **퇴직 확정(`finalize`)은 하지 않는다** — 상태는 EMPLOYED 로 남고, 다음 날 `retireDue` 배치가 근무스케줄 삭제 · 개인 TO-DO
   * 배정 해제를 한다(계약 · 초대는 위에서 이미 닫혀 배치가 다시 닫을 것이 없어도 문제없다). 시작일이 폐점일 뒤인 체결 완료 계약은
   * 그대로 둔다(CTR-31, 출근은 WHALEERP-643 이 막는다).
   *
   * @returns 1팀이 결과 안내와 점포 변경 이력에 쓴다 (폐점 확인 서비스 WHALEERP-647 과 같은 이름 · 뜻).
   *   - `retiringStaff`: 퇴직될 직원 수 — 폐점 확인 서비스(647)의 퇴직될 직원과 같은 기준: 그 점포의 재직 레코드 중 임시저장만 있는 가입 전이 아닌 것 전부(퇴직일 없음 · 당김 · 폐점일 이전/같은 날 모두). 임시저장만 있던 가입 전 레코드는 퇴직일을 정하지만 세지 않는다(`draftContracts` 로 드러난다)
   *   - `pulledForwardStaff`: 퇴직일을 폐점일로 당긴 수
   *   - `draftContracts`: 종료로 닫은 임시저장 계약 수
   *   - `pendingSendContracts`: 종료로 닫은 발송 대기 계약 수
   *   - `pendingSignatureContracts`: 종료로 닫은 서명 대기 + 수정 요청 계약 수
   *   - `expiredInvitations`: 만료로 바꾼 발송(SENT) 초대 수
   */
  async retireStore(
    tx: Tx,
    storeId: number,
    closedDate: Date,
    adminAccountId: number,
    now: Date = new Date(),
  ): Promise<StoreClosingRetirementResult> {
    const { byStore } = await this.retireStores(
      tx,
      [storeId],
      closedDate,
      adminAccountId,
      now,
    );
    return byStore[storeId];
  }

  /**
   * 점포 여러 개를 한 번에 폐점 퇴직 처리한다 (WHALEERP-651, 회원 탈퇴 시 소유 점포 자동 폐점). `retireStore` 와 같은 규칙을
   * 점포 수만큼 쿼리가 늘지 않게 `IN` 으로 한 번씩 처리한다. 1팀이 같은 트랜잭션에서 점포 행을 **모두 id 오름차순으로 잠근 뒤**,
   * 폐점 확인 다음에 부른다 (1팀 답 2026-11-04). 점포 하나도 `[storeId]` 로 부른다.
   *
   * - 잠금: 모든 점포의 재직(EMPLOYED) 직원 행을 `store_id IN (...)` 한 번에 `staff_member_id` 오름차순 `FOR NO KEY UPDATE`,
   *   그 계정 행(중복 제거 — 한 계정이 여러 점포에 레코드가 있어도 한 번)을 `account_id` 오름차순 `FOR UPDATE` 한 번.
   * - 열린 출근: 잠근 뒤 재직 레코드 전체를 한 번의 쿼리로 본다(`assertNoOpenCheckIn` 과 같은 기준). 있으면 409 `OPEN_CHECK_IN`
   *   (본문에 `storeId` — 가장 이른 열린 출근의 점포)으로 트랜잭션째 되돌린다.
   * - 퇴직일 · 퇴직될 직원 수 · 초대 만료 · 대기 계약 종료는 `retireStore` 와 같은 규칙. 점포별 수는 레코드의 `storeId` 칸에 더한다.
   * - 퇴직 확정은 하지 않는다(다음 날 `retireDue`). 예외는 삼키지 않는다. 직원 알림 없음.
   *
   * @param storeIds 중복은 한 번으로 본다. 빈 배열이면 쿼리 없이 0 을 돌려준다.
   */
  async retireStores(
    tx: Tx,
    storeIds: number[],
    closedDate: Date,
    adminAccountId: number,
    now: Date = new Date(),
  ): Promise<StoresClosingRetirementResult> {
    const ids = [...new Set(storeIds)].sort((x, y) => x - y);
    const byStore: Record<number, StoreClosingRetirementResult> = {};
    for (const id of ids) byStore[id] = emptyResult();
    const total = emptyResult();
    const result = { byStore, total };
    if (ids.length === 0) return result;
    const closed = kstToday(closedDate);

    // 점포(1팀) → 직원 → 계정 순으로 잠근다. FOR NO KEY UPDATE 는 잠근 뒤의 행 값으로 조건을 다시 본다.
    const locked = await tx.$queryRaw<
      { staff_member_id: number; account_id: number | null }[]
    >`SELECT staff_member_id, account_id FROM staff_members WHERE store_id IN (${Prisma.join(ids)}) AND employment_status = 'EMPLOYED' ORDER BY staff_member_id FOR NO KEY UPDATE`;
    const accountIds = [
      ...new Set(
        locked.flatMap(({ account_id }) =>
          account_id === null ? [] : [account_id],
        ),
      ),
    ].sort((x, y) => x - y);
    if (accountIds.length > 0)
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id IN (${Prisma.join(accountIds)}) ORDER BY account_id FOR UPDATE`;

    const lockedIds = locked.map((l) => l.staff_member_id);
    if (lockedIds.length > 0)
      await assertNoOpenCheckIn(tx, { in: lockedIds }, true);

    // 조회와 잠금 사이에 생긴 재직 레코드는 퇴직되지 않을 수 있다 — 1팀이 점포를 FOR UPDATE 로 잡는 동안은 새 직원 레코드 insert(외래키)가
    // 막히지만, FOR NO KEY UPDATE 로 바꾸면 틈이 생긴다. 짧은 틈이라 받아들인 위험(2026-11-03 노영주).
    // 임시저장만 있던 가입 전 레코드도 퇴직일은 정한다 — 아래에서 그 임시저장이 닫혀 재직으로 세지므로(CTR-29) 퇴직일을 정해 둬야
    // 다음 날 배치가 확정한다.
    const members =
      lockedIds.length === 0
        ? []
        : await tx.staffMember.findMany({
            where: { staffMemberId: { in: lockedIds } },
            select: {
              staffMemberId: true,
              storeId: true,
              joinStatus: true,
              retiredDate: true,
            },
            orderBy: { staffMemberId: 'asc' },
          });
    // 퇴직될 직원으로 세는 기준(폐점 확인 647 과 같다)은 계약을 닫기 전에 판정한다 — 가입 전 레코드의 임시저장 아닌 계약을 한 번에 본다
    const preJoinIds = members
      .filter((m) => m.joinStatus !== 'JOINED')
      .map((m) => m.staffMemberId);
    const withSentContract = new Set(
      preJoinIds.length === 0
        ? []
        : (
            await tx.contract.groupBy({
              by: ['staffMemberId'],
              where: {
                staffMemberId: { in: preJoinIds },
                status: { not: 'DRAFT' },
              },
            })
          ).map((g) => g.staffMemberId),
    );
    for (const { staffMemberId, storeId, joinStatus, retiredDate } of members) {
      const mine = byStore[storeId];
      const draftOnlyPreJoin =
        joinStatus !== 'JOINED' && !withSentContract.has(staffMemberId);
      if (!draftOnlyPreJoin) mine.retiringStaff += 1;
      if (retiredDate !== null && retiredDate <= closed) continue;
      if (retiredDate !== null) {
        await tx.staffMemberRetirementLog.create({
          data: {
            staffMemberId,
            action: 'CANCEL',
            retiredDate,
            processedBy: adminAccountId,
            processedAt: now,
          },
        });
        mine.pulledForwardStaff += 1;
      }
      await this.schedule(tx, adminAccountId, staffMemberId, closed, now);
    }

    for (const { status, storeId } of await this.endPendingContracts(
      tx,
      { storeId: { in: ids } },
      'ADMIN',
    )) {
      if (storeId === null || !byStore[storeId]) continue;
      const mine = byStore[storeId];
      if (status === 'DRAFT') mine.draftContracts += 1;
      else if (status === 'PENDING_SEND') mine.pendingSendContracts += 1;
      else mine.pendingSignatureContracts += 1;
    }

    const expired = await tx.invitation.updateManyAndReturn({
      where: { status: 'SENT', staffMember: { storeId: { in: ids } } },
      data: { status: 'EXPIRED' },
      select: { staffMemberId: true },
    });
    if (expired.length > 0) {
      const records = await tx.staffMember.findMany({
        where: {
          staffMemberId: {
            in: [...new Set(expired.map((e) => e.staffMemberId))],
          },
        },
        select: { staffMemberId: true, storeId: true },
      });
      const storeOf = new Map(records.map((r) => [r.staffMemberId, r.storeId]));
      for (const { staffMemberId } of expired) {
        const storeId = storeOf.get(staffMemberId);
        if (storeId !== undefined && byStore[storeId])
          byStore[storeId].expiredInvitations += 1;
      }
    }

    for (const mine of Object.values(byStore))
      for (const key of Object.keys(total) as (keyof typeof total)[])
        total[key] += mine[key];
    return result;
  }

  /** 대기 계약 4종을 종료로 닫고 상태 이력을 남긴다. 닫은 계약마다 (이전 상태, 점포)를 돌려준다. */
  private async endPendingContracts(
    tx: Tx,
    where: Prisma.ContractWhereInput,
    actor: StatusChangeActor,
  ): Promise<{ status: ContractStatus; storeId: number | null }[]> {
    const closed: { status: ContractStatus; storeId: number | null }[] = [];
    for (const status of PENDING_CONTRACT_STATUSES) {
      const ended = await tx.contract.updateManyAndReturn({
        where: { ...where, status },
        data: { status: 'ENDED' },
        select: { contractId: true, storeId: true },
      });
      if (ended.length === 0) continue;
      closed.push(...ended.map(({ storeId }) => ({ status, storeId })));
      await tx.contractStatusHistory.createMany({
        data: ended.map(({ contractId }) => ({
          contractId,
          fromStatus: status,
          toStatus: 'ENDED' as const,
          actor,
        })),
      });
    }
    return closed;
  }

  /** 지난 날짜면 배치를 기다리지 않고 지금 처리한 관리자로 확정한다. 오늘은 지난 날짜가 아니다. */
  private async finalizeIfPast(
    tx: Tx,
    adminAccountId: number,
    staffMemberId: number,
    retiredDate: Date,
    today: Date,
  ): Promise<void> {
    if (retiredDate < today)
      await this.finalize(tx, staffMemberId, retiredDate, {
        actor: 'ADMIN',
        adminAccountId,
      });
  }

  /** 퇴직일을 저장하고 RETIRE 로그를 남긴다. 계약은 바꾸지 않고, 걸친 계약의 그 시점 종료일만 적는다. */
  private async schedule(
    tx: Tx,
    adminAccountId: number,
    staffMemberId: number,
    retiredDate: Date,
    now: Date,
  ): Promise<void> {
    await tx.staffMember.update({
      where: { staffMemberId },
      data: { retiredDate },
    });
    // 지난 퇴직일이면 걸친 계약이 하루 배치로 이미 종료됐을 수 있다 — 체결 완료와 기간이 끝나 종료된 계약을 함께 본다(api #152 리뷰)
    const spanning = await tx.contract.findMany({
      where: {
        staffMemberId,
        AND: [SIGNED_ONCE],
        startDate: { lte: retiredDate },
        OR: [{ endDate: null }, { endDate: { gte: retiredDate } }],
      },
      select: { contractId: true, endDate: true },
      orderBy: { contractId: 'asc' },
    });
    // 같은 처리의 행은 같은 처리 시각을 갖는다 — 한 번의 처리를 묶어 읽는 기준이다.
    const base = {
      staffMemberId,
      action: 'RETIRE' as const,
      retiredDate,
      processedBy: adminAccountId,
      processedAt: now,
    };
    await tx.staffMemberRetirementLog.createMany({
      data:
        spanning.length === 0
          ? [base]
          : spanning.map(({ contractId, endDate }) => ({
              ...base,
              contractId,
              previousContractEndDate: endDate,
            })),
    });
  }

  /**
   * 퇴직을 확정한다. 재직 → 퇴직을 먼저 조건부로 바꾸고, 바꾼 경우에만 정리한다 — 이미 누가 확정했으면
   * 아무것도 하지 않는다. 같은 트랜잭션이라 상태와 정리가 따로 남지 않는다.
   * @returns 이번에 확정했으면 true
   */
  private async finalize(
    tx: Tx,
    staffMemberId: number,
    retiredDate: Date,
    by: Finalizer,
  ): Promise<boolean> {
    const { count } = await tx.staffMember.updateMany({
      where: { staffMemberId, employmentStatus: 'EMPLOYED', retiredDate },
      data: { employmentStatus: 'RETIRED' },
    });
    if (count === 0) return false;

    await this.removeSchedules(tx, staffMemberId, retiredDate, by);

    const changedBy = by.actor === 'ADMIN' ? by.adminAccountId : null;
    const assignments = await tx.todoAssignee.findMany({
      where: this.openPersonalAssignments(staffMemberId),
      select: { todoId: true, todo: { select: { status: true } } },
    });
    if (assignments.length > 0) {
      await tx.todoAssignee.deleteMany({
        where: {
          staffMemberId,
          todoId: { in: assignments.map((a) => a.todoId) },
        },
      });
      // 배정 해제는 상태가 바뀌는 일이 아니라 같은 상태 그대로 남긴다. 누구의 배정이 풀렸는지가 기록이다.
      await tx.todoStatusHistory.createMany({
        data: assignments.map(({ todoId, todo }) => ({
          todoId,
          fromStatus: todo.status,
          toStatus: todo.status,
          changedBy,
          unassignedStaffMemberId: staffMemberId,
        })),
      });
    }

    // 가입 전 레코드의 이미 나간 가입 초대는 무효로 한다 — 퇴직한 뒤 그 링크로 가입 · 날인하지 않게(CTR-25, 2026-10-19 재영)
    await tx.invitation.updateMany({
      where: { staffMemberId, status: 'SENT' },
      data: { status: 'EXPIRED' },
    });

    await this.endPendingContracts(tx, { staffMemberId }, by.actor);
    return true;
  }

  /**
   * 퇴직일 다음 날부터의 근무스케줄을 지우고 스케줄마다 삭제 이력을 남긴다 — 화면의 변경 이력에서
   * 스케줄이 이유 없이 사라지지 않게. 이력의 변경 주체(`changed_by`)는 관리자여야 하므로(NOT NULL), 배치가
   * 지울 때는 그 퇴직을 처리한 관리자(마지막 RETIRE 로그의 처리자)를 쓴다 — 삭제는 그 처리의 결과다.
   */
  private async removeSchedules(
    tx: Tx,
    staffMemberId: number,
    retiredDate: Date,
    by: Finalizer,
  ): Promise<void> {
    const removed = await tx.workSchedule.updateManyAndReturn({
      where: this.schedulesAfter(staffMemberId, retiredDate),
      data: { isDeleted: true },
      select: {
        workScheduleId: true,
        startAt: true,
        endAt: true,
        breakMinutes: true,
      },
    });
    if (removed.length === 0) return;

    const changedBy =
      by.actor === 'ADMIN'
        ? by.adminAccountId
        : (
            await tx.staffMemberRetirementLog.findFirstOrThrow({
              where: { staffMemberId, action: 'RETIRE' },
              orderBy: [
                { processedAt: 'desc' },
                { staffMemberRetirementLogId: 'desc' },
              ],
              select: { processedBy: true },
            })
          ).processedBy;
    await tx.workScheduleHistory.createMany({
      data: removed.map(({ workScheduleId, ...before }) => ({
        workScheduleId,
        changeType: 'DELETED' as const,
        beforeValue: {
          ...before,
          startAt: before.startAt.toISOString(),
          endAt: before.endAt.toISOString(),
        },
        changedBy,
      })),
    });
  }

  /** 퇴직일 다음 날 한국 0시부터 시작하는, 지우지 않은 근무스케줄. */
  private schedulesAfter(
    staffMemberId: number,
    retiredDate: Date,
  ): Prisma.WorkScheduleWhereInput {
    return {
      staffMemberId,
      isDeleted: false,
      startAt: { gte: kstDayStart(addDays(retiredDate, 1)) },
    };
  }

  /** 이 직원에게 개인으로 배정된, 아직 끝나지 않은 TO-DO. 끝난 배정은 기록이라 건드리지 않는다. */
  private openPersonalAssignments(
    staffMemberId: number,
  ): Prisma.TodoAssigneeWhereInput {
    return {
      staffMemberId,
      isCompleted: false,
      todo: {
        assigneeType: 'INDIVIDUAL',
        isDeleted: false,
        status: { not: 'DONE' },
      },
    };
  }

  /**
   * 퇴직일은 오늘 이후이거나 최근 3개월 안의 지난 날짜만 받는다. 입사일보다 앞설 수는 없다 — 지난 날짜로
   * 처리하면 그 다음 날부터의 스케줄을 지우므로, 일한 기간의 스케줄까지 사라진다. 다만 입사일이 아직 오지 않았으면
   * (시작일이 미래인 계약을 체결해 두고 입사 전에 그만둠) 앞선 날도 받는다 — 일한 기간이 없다(WHALEERP-613,
   * 2026-10-22 김민식).
   */
  private assertDateAllowed(
    retiredDate: Date,
    today: Date,
    hiredDate: Date | null,
  ): void {
    if (retiredDate < addMonths(today, -MAX_PAST_MONTHS))
      throw new BadRequestException(
        '퇴직일은 오늘 이후이거나 최근 3개월 안의 날짜여야 합니다.',
      );
    if (hiredDate && hiredDate <= today && retiredDate < hiredDate)
      throw new BadRequestException('퇴직일은 입사일보다 앞설 수 없습니다.');
  }

  /**
   * 퇴직 처리를 받을 수 있는 레코드인지 — 재직으로 세고 아직 퇴직하지 않았다. 재직은 근로계약서를 받을 때부터라
   * (WHALEERP-125 「재직과 매장 정보」) 가입 전 레코드도 받는다. 임시저장 계약만 있는 레코드는 재직으로 세지 않는다
   * (CTR-25, 2026-10-19 재영) — 임시저장을 지우면 된다.
   */
  private async assertCanRetire(
    client: Pick<Tx, 'contract'>,
    staffMemberId: number,
    staff: { joinStatus: string; employmentStatus: string },
  ): Promise<void> {
    if (await this.isDraftOnlyPreJoin(client, staffMemberId, staff))
      throw new ConflictException(
        '임시저장 근로계약만 있는 직원은 퇴직 처리 대신 임시저장을 지워 주세요.',
      );
    if (staff.employmentStatus === 'RETIRED')
      throw new ConflictException('이미 퇴직한 직원입니다.');
  }

  /** 가입 전이면서 임시저장이 아닌 계약이 하나도 없는 레코드 — 재직으로 세지 않는다. */
  private async isDraftOnlyPreJoin(
    client: Pick<Tx, 'contract'>,
    staffMemberId: number,
    staff: { joinStatus: string },
  ): Promise<boolean> {
    return (
      staff.joinStatus !== 'JOINED' &&
      (await client.contract.count({
        where: { staffMemberId, status: { not: 'DRAFT' } },
      })) === 0
    );
  }

  /** 퇴직 예정(재직 + 퇴직일 있음)이고 퇴직일 전날까지인지 확인한다. 지금의 퇴직일과 입사일을 돌려준다. */
  private async lockScheduled(
    tx: Tx,
    staffMemberId: number,
    today: Date,
  ): Promise<{ retiredDate: Date; hiredDate: Date | null }> {
    const staff = await this.lockStaff(tx, staffMemberId);
    if (staff.employmentStatus !== 'EMPLOYED' || staff.retiredDate === null)
      throw new ConflictException('퇴직 예정인 직원이 아닙니다.');
    if (staff.retiredDate <= today)
      throw new ConflictException(
        '퇴직일 전날까지만 취소하거나 퇴직일을 바꿀 수 있습니다.',
      );
    return { retiredDate: staff.retiredDate, hiredDate: staff.hiredDate };
  }

  private async lockStaff(tx: Tx, staffMemberId: number) {
    // 직원 행 → 계정 행 순으로 잠근다 — 생년월일 정정 · 세무 정보와 같은 순서. 직원 행은 FOR NO KEY UPDATE 라 직원 출근이 계정을 잡은 뒤
    // 기록을 넣으며 거는 외래키 잠금(FOR KEY SHARE)과 부딪히지 않는다 — 그래서 계정부터 잡는 출퇴근과 교착하지 않는다(PR #159 리뷰).
    // 계정 행을 잡으면 열린 출근을 본 뒤 그사이 출근이 들어와 퇴직하는 소속에 열린 출근이 남는 일이 없다
    await tx.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR NO KEY UPDATE`;
    const row = await tx.staffMember.findUnique({
      where: { staffMemberId },
      select: { accountId: true },
    });
    if (row?.accountId)
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${row.accountId} FOR UPDATE`;
    return this.findStaff(tx, staffMemberId);
  }

  private async findStaff(
    client: Pick<Tx, 'staffMember'>,
    staffMemberId: number,
  ) {
    const staff = await client.staffMember.findUnique({
      where: { staffMemberId },
      select: {
        joinStatus: true,
        hiredDate: true,
        employmentStatus: true,
        retiredDate: true,
      },
    });
    if (!staff) throw new NotFoundException('직원을 찾을 수 없습니다.');
    return staff;
  }
}

/** 열린 출근의 기준 — 보정할 수 있는 3개월 안, 짝 퇴근이 없는 출근. 단건 · 일괄 퇴직 처리가 같이 쓴다. */
function openCheckInWhere(
  staffMemberId: number | { in: number[] },
): Prisma.AttendanceRecordWhereInput {
  return {
    staffMemberId,
    kind: 'CHECK_IN',
    attendanceRecordsAsCheckIn: { none: {} },
    recordedAt: { gte: editableStart() },
  };
}

/**
 * 그 점포(직원 레코드)에 퇴근하지 않은 출근이 있으면 퇴직 처리(퇴직일 저장)를 막는다 — 퇴직한 소속에 아무도 닫을 수 없는 열린 출근이
 * 남지 않게, 먼저 보정으로 닫게 한다(2026-10-27 재영). 보정할 수 있는 기간(3개월)보다 오래 열린 출근은 닫을 수 없어 막지 않는다.
 * 퇴직일까지 그 사이 생긴 열린 출근은 퇴근 미등록으로 남고 관리자가 보정한다.
 */
async function assertNoOpenCheckIn(
  tx: Pick<Tx, 'attendanceRecord'>,
  staffMemberId: number | { in: number[] },
  withStoreId = false,
): Promise<void> {
  const open = await tx.attendanceRecord.findFirst({
    where: openCheckInWhere(staffMemberId),
    orderBy: [{ recordedAt: 'asc' }, { attendanceRecordId: 'asc' }],
    select: { recordedAt: true, storeId: true },
  });
  if (!open) return;
  const day = kstToday(open.recordedAt);
  const at = `${day.toISOString().slice(5, 10).replace('-', '/')} ${kstTimeOf(open.recordedAt)}`;
  // 아직 앱으로 퇴근할 수 있는 출근(출근한 다음 날까지)은 근무 중일 수 있다 — 지어낸 퇴근으로 닫게 하지 않고 퇴근 뒤 다시 하게 한다
  const working = day >= addDays(kstToday(), -1);
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'OPEN_CHECK_IN',
    message: working
      ? `${at} 출근이 아직 퇴근 전입니다. 퇴근이 등록된 뒤 다시 처리해 주세요.`
      : `${at} 퇴근하지 않은 출근이 있습니다. 출 · 퇴근 현황에서 먼저 보정으로 닫아 주세요.`,
    // 점포 폐점(retireStore · retireStores)은 어느 점포인지 storeId 를 더한다 — 단건 퇴직 retire · changeDate 의 본문은 그대로
    ...(withStoreId && { storeId: open.storeId }),
  });
}
