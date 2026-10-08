import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma, StatusChangeActor } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RetirementPreviewResponseDto } from './dto/retirement-preview.response.dto';
import { addDays, addMonths, kstDayStart, kstToday } from './kst-date';

/** 퇴직이 확정될 때 종료로 닫는 계약 상태 — 아직 체결되지 않은 절차. */
const PENDING_CONTRACT_STATUSES: ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
];

/** 지난 날짜로 처리할 수 있는 한도. 그보다 오래된 퇴직은 받지 않는다. */
const MAX_PAST_MONTHS = 3;

type Tx = Prisma.TransactionClient;

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
  constructor(private readonly prisma: PrismaService) {}

  /** 확인창용. 처리와 같은 검사를 한다 — 확인창은 뜨는데 처리가 거부되는 일이 없게. */
  async preview(
    staffMemberId: number,
    retiredDate: Date,
    now: Date = new Date(),
  ): Promise<RetirementPreviewResponseDto> {
    const staff = await this.findStaff(this.prisma, staffMemberId);
    this.assertCanRetire(staff);
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
      this.assertCanRetire(staff);
      if (staff.retiredDate !== null)
        throw new ConflictException(
          '이미 퇴직 예정입니다. 퇴직일을 바꾸려면 퇴직일 변경을 써 주세요',
        );
      this.assertDateAllowed(retiredDate, today, staff.hiredDate);

      await this.schedule(tx, adminAccountId, staffMemberId, retiredDate, now);
      if (retiredDate < today)
        await this.finalize(tx, staffMemberId, retiredDate, {
          actor: 'ADMIN',
          adminAccountId,
        });
    });
  }

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
        throw new ConflictException('지금 퇴직일과 같습니다');
      this.assertDateAllowed(retiredDate, today, hiredDate);
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
      if (retiredDate < today)
        await this.finalize(tx, staffMemberId, retiredDate, {
          actor: 'ADMIN',
          adminAccountId,
        });
    });
  }

  async cancel(
    adminAccountId: number,
    staffMemberId: number,
    now: Date = new Date(),
  ): Promise<void> {
    const today = kstToday(now);
    await this.prisma.$transaction(async (tx) => {
      const { retiredDate: current } = await this.lockScheduled(
        tx,
        staffMemberId,
        today,
      );
      await tx.staffMember.update({
        where: { staffMemberId },
        data: { retiredDate: null },
      });
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
   * @returns 퇴직으로 바꾼 레코드 수
   */
  async retireDue(tx: Tx, today: Date): Promise<number> {
    const due = await tx.staffMember.findMany({
      where: { employmentStatus: 'EMPLOYED', retiredDate: { lt: today } },
      select: { staffMemberId: true, retiredDate: true },
    });
    let retired = 0;
    for (const { staffMemberId, retiredDate } of due)
      if (
        retiredDate &&
        (await this.finalize(tx, staffMemberId, retiredDate, {
          actor: 'SYSTEM',
        }))
      )
        retired += 1;
    return retired;
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
    const spanning = await tx.contract.findMany({
      where: {
        staffMemberId,
        status: 'SIGNED',
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

    const actor: StatusChangeActor = by.actor;
    for (const status of PENDING_CONTRACT_STATUSES) {
      const ended = await tx.contract.updateManyAndReturn({
        where: { staffMemberId, status },
        data: { status: 'ENDED' },
        select: { contractId: true },
      });
      if (ended.length > 0)
        await tx.contractStatusHistory.createMany({
          data: ended.map(({ contractId }) => ({
            contractId,
            fromStatus: status,
            toStatus: 'ENDED' as const,
            actor,
          })),
        });
    }
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
   * 처리하면 그 다음 날부터의 스케줄을 지우므로, 일한 기간의 스케줄까지 사라진다.
   */
  private assertDateAllowed(
    retiredDate: Date,
    today: Date,
    hiredDate: Date | null,
  ): void {
    if (retiredDate < addMonths(today, -MAX_PAST_MONTHS))
      throw new BadRequestException(
        '퇴직일은 오늘 이후이거나 최근 3개월 안의 날짜여야 합니다',
      );
    if (hiredDate && retiredDate < hiredDate)
      throw new BadRequestException('퇴직일은 입사일보다 앞설 수 없습니다');
  }

  /** 퇴직 처리를 받을 수 있는 레코드인지 — 가입을 마쳤고 아직 퇴직하지 않았다. */
  private assertCanRetire(staff: {
    joinStatus: string;
    employmentStatus: string;
  }): void {
    if (staff.joinStatus !== 'JOINED')
      throw new ConflictException(
        '가입하지 않은 직원은 퇴직 처리 대신 삭제해 주세요',
      );
    if (staff.employmentStatus === 'RETIRED')
      throw new ConflictException('이미 퇴직한 직원입니다');
  }

  /** 퇴직 예정(재직 + 퇴직일 있음)이고 퇴직일 전날까지인지 확인한다. 지금의 퇴직일과 입사일을 돌려준다. */
  private async lockScheduled(
    tx: Tx,
    staffMemberId: number,
    today: Date,
  ): Promise<{ retiredDate: Date; hiredDate: Date | null }> {
    const staff = await this.lockStaff(tx, staffMemberId);
    if (staff.employmentStatus !== 'EMPLOYED' || staff.retiredDate === null)
      throw new ConflictException('퇴직 예정인 직원이 아닙니다');
    if (staff.retiredDate <= today)
      throw new ConflictException(
        '퇴직일 전날까지만 취소하거나 퇴직일을 바꿀 수 있습니다',
      );
    return { retiredDate: staff.retiredDate, hiredDate: staff.hiredDate };
  }

  private async lockStaff(tx: Tx, staffMemberId: number) {
    await tx.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR UPDATE`;
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
    if (!staff) throw new NotFoundException('직원을 찾을 수 없습니다');
    return staff;
  }
}
