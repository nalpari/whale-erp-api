import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StatusChangeActor } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { requireAreaRead } from '../auth/menu-permission.guard';
import { dateOnly } from '../common/date-only';
import { amountOf, BASE_PAY_ITEM_CODE } from '../payslips/payslip-shared';
import { PrismaService } from '../prisma/prisma.service';
import { kstTimeOf, workDateOf } from '../work-schedules/work-schedule-rules';
import {
  StaffMemberContractSummaryResponseDto,
  StaffMemberPayslipSummaryResponseDto,
  StaffMemberRecentPayslipDto,
  StaffMemberTodoSummaryResponseDto,
  StaffMemberWeekScheduleResponseDto,
} from './dto/staff-member-summary.response.dto';
import { addDays, kstDayStart, kstToday, parseDateOnly } from './kst-date';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';
// 갱신 예정일 — 근로계약 목록과 같은 규칙(종료일 30일 전, 갱신 예정 알림 배치와 같은 날수)
import { renewalDateOf } from '../contracts/contract-renewal';

/** TO-DO 최근 처리 이력 건수 */
const RECENT_TODO_HISTORIES = 5;
const MINUTE_MS = 60 * 1000;

/** 급여명세서 최근 명세서 건수 */
const RECENT_PAYSLIPS = 3;

const PAYSLIP_SELECT = {
  payslipId: true,
  periodStartDate: true,
  periodEndDate: true,
  status: true,
  grossPayAmount: true,
  totalDeductionAmount: true,
  netPayAmount: true,
  // 명세서 · 급여 항목은 한 쌍에 한 행(unique)이라 많아야 하나다
  payslipItems: {
    where: { payslipItemMaster: { itemCode: BASE_PAY_ITEM_CODE } },
    select: { isEntered: true, adjustedAmount: true, calculatedAmount: true },
  },
} as const satisfies Prisma.PayslipSelect;

type PayslipRow = Prisma.PayslipGetPayload<{ select: typeof PAYSLIP_SELECT }>;

// 칸을 하나씩 옮긴다 — 펼치면 PAYSLIP_SELECT 에 더한 칸이 응답에 조용히 실린다
const toRecentPayslip = (p: PayslipRow): StaffMemberRecentPayslipDto => {
  // 지급 총액과 같은 기준(amountOf) — 줄이 없거나 넣지 않았으면(isEntered = false) null
  const base = p.payslipItems[0];
  const basePayAmount = base ? amountOf(base) : null;
  return {
    payslipId: p.payslipId,
    periodStartDate: dateOnly(p.periodStartDate),
    periodEndDate: dateOnly(p.periodEndDate),
    basePayAmount,
    allowanceAmount: p.grossPayAmount - (basePayAmount ?? 0),
    totalDeductionAmount: p.totalDeductionAmount,
    netPayAmount: p.netPayAmount,
    status: p.status,
  };
};

/**
 * 직원 상세 요약(WHALEERP-183)의 영역들 — 근로계약 · 근무스케줄 · 급여명세서 · TO-DO. 영역마다 경로가 따로라 한 영역이
 * 실패해도 나머지는 그대로 온다. 경로는 직원 정보 관리 조회 권한(컨트롤러)을 거치고, 여기서 그 영역 메뉴의 조회 권한을
 * 다시 본다 — 없으면 그 영역만 403(2026-10-21 노영주). 권한을 범위보다 먼저 봐서 권한이 없으면 어떤 ID 든 같은 403 이다.
 * 범위는 직원 상세와 같다(canManageStaffMember) — 없는 직원 · 관리 범위 밖 · 가려지는 직원은 같은 404.
 */
@Injectable()
export class StaffMemberSummaryService {
  private readonly logger = new Logger(StaffMemberSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 가장 최근 근로계약. 「가장 최근」은 직원 목록 · 상세의 contract 와 같은 정렬이다 */
  async contract(
    adminAccountId: number,
    staffMemberId: number,
    now: Date = new Date(),
  ): Promise<StaffMemberContractSummaryResponseDto> {
    await this.check(adminAccountId, staffMemberId, '/contracts');
    const c = await this.prisma.contract.findFirst({
      where: { staffMemberId },
      // created_at 은 nullable 이다. DESC 의 기본은 NULL 먼저라 오래된 계약이 「최근」이 될 수 있다.
      orderBy: [
        { createdAt: { sort: 'desc', nulls: 'last' } },
        { contractId: 'desc' },
      ],
      select: {
        contractId: true,
        employmentType: true,
        contractMethod: true,
        status: true,
        startDate: true,
        endDate: true,
        sentAt: true,
      },
    });
    if (!c) return { contract: null };
    return {
      contract: {
        contractId: c.contractId,
        employmentType: c.employmentType,
        contractMethod: c.contractMethod,
        status: c.status,
        startDate: dateOnly(c.startDate),
        endDate: dateOnly(c.endDate),
        lastSentAt: c.sentAt,
        renewalDate: dateOnly(renewalDateOf(c, now)),
      },
    };
  }

  /**
   * 한 주(월~일) 근무스케줄. 근무일은 시작 일시의 한국 날짜다(근무스케줄 관리와 같다) — 일요일 밤에 시작해 월요일로 넘어간
   * 근무는 그 주에 든다. 지운 것만 뺀다 — 근무스케줄 관리 화면이 보이는 행과 같다. 퇴직이 확정되면(퇴직일 다음 날 배치)
   * 퇴직일 뒤 근무스케줄이 지워지고, 퇴직 예정인 동안에는 남아 보인다.
   */
  async workSchedules(
    adminAccountId: number,
    staffMemberId: number,
    weekStart: string | undefined,
    now: Date = new Date(),
  ): Promise<StaffMemberWeekScheduleResponseDto> {
    await this.check(adminAccountId, staffMemberId, '/work-schedules');
    // 컨트롤러의 검증이 막지만, 서비스를 직접 부른 잘못된 값을 이번 주로 바꿔 답하지 않는다
    const day =
      weekStart === undefined ? kstToday(now) : parseDateOnly(weekStart);
    if (!day)
      throw new BadRequestException(
        'weekStart 는 YYYY-MM-DD 형식의 있는 날짜입니다',
      );
    // getUTCDay 는 일요일이 0 — 월요일로부터 며칠 지났는지로 바꾼다
    const monday = addDays(day, -((day.getUTCDay() + 6) % 7));
    const rows = await this.prisma.workSchedule.findMany({
      where: {
        staffMemberId,
        isDeleted: false,
        startAt: {
          gte: kstDayStart(monday),
          lt: kstDayStart(addDays(monday, 7)),
        },
      },
      select: {
        workScheduleId: true,
        storeId: true,
        startAt: true,
        endAt: true,
        breakMinutes: true,
      },
      orderBy: [{ startAt: 'asc' }, { workScheduleId: 'asc' }],
    });
    // stores 는 1팀 테이블이라 Prisma 관계가 없다 — 점포 id 로 따로 묻는다
    const stores = rows.length
      ? await this.prisma.store.findMany({
          where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
          select: { storeId: true, name: true },
        })
      : [];
    const nameOf = new Map(stores.map((s) => [s.storeId, s.name]));
    const items = rows.map((r) => {
      const storeName = nameOf.get(r.storeId);
      // 근무스케줄의 점포는 외래키로 묶여 있다. 못 찾으면 데이터가 깨진 것이라 빈 칸으로 내보내지 않는다(직원 목록과 같다)
      if (storeName === undefined)
        throw new InternalServerErrorException(
          `근무스케줄 ${r.workScheduleId} 의 점포 ${r.storeId} 를 찾을 수 없습니다`,
        );
      return {
        workScheduleId: r.workScheduleId,
        storeId: r.storeId,
        storeName,
        workDate: dateOnly(workDateOf(r.startAt)),
        startTime: kstTimeOf(r.startAt),
        endTime: kstTimeOf(r.endAt),
        breakMinutes: r.breakMinutes,
        workMinutes:
          (r.endAt.getTime() - r.startAt.getTime()) / MINUTE_MS -
          r.breakMinutes,
      };
    });
    return {
      weekStart: dateOnly(monday),
      weekEnd: dateOnly(addDays(monday, 6)),
      items,
      totalWorkMinutes: items.reduce((sum, i) => sum + i.workMinutes, 0),
    };
  }

  /**
   * 최근 명세서 3건과 미발송 건수. 최근은 상태와 관계없이(작성 중 포함) 급여 기간 시작일 최신순이다(같으면 명세서 ID
   * 내림차순). 기본급은 BASE_PAY 항목의 금액(지급 총액과 같은 amountOf — 넣지 않았으면 null), 수당은 지급 총액 − 기본급이다(기본급이 없으면
   * 지급 총액 그대로). 미발송은 발송 완료가 아닌 모두다(작성 중 · 검토 중 · 확정, 2026-10-21 노영주 — 데모 기준).
   */
  async payslips(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<StaffMemberPayslipSummaryResponseDto> {
    await this.check(adminAccountId, staffMemberId, '/payslips');
    const [recent, unsentCount] = await Promise.all([
      this.prisma.payslip.findMany({
        where: { staffMemberId },
        orderBy: [{ periodStartDate: 'desc' }, { payslipId: 'desc' }],
        take: RECENT_PAYSLIPS,
        select: PAYSLIP_SELECT,
      }),
      this.prisma.payslip.count({
        where: { staffMemberId, status: { not: 'SENT' } },
      }),
    ]);
    return { recent: recent.map(toRecentPayslip), unsentCount };
  }

  /**
   * 이 직원에게 배정된 TO-DO 의 건수와 최근 변경 이력. 행마다 상태가 있으므로(한 명 수행은 공유 1행) 완료는 행의 상태로
   * 센다 — 한 명 수행은 다른 배정자가 끝내도 완료다. 건수는 한 쿼리(groupBy)로 세어 전체 = 완료 + 미완료가 늘 맞는다.
   * 퇴직으로 배정이 풀린 TO-DO(미완료 개인 배정)는 배정 행이 지워져 들지 않는다. 이력은 등록 · 상태 변경 · 긴급 표시
   * 변경을 바뀐 일시 내림차순으로 담고, 다른 배정자의 퇴직 배정 해제 행(같은 상태 그대로)은 뺀다.
   */
  async todos(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<StaffMemberTodoSummaryResponseDto> {
    await this.check(adminAccountId, staffMemberId, '/todos');
    const assigned = {
      isDeleted: false,
      todoAssignees: { some: { staffMemberId } },
    } satisfies Prisma.TodoWhereInput;
    const [counts, histories] = await Promise.all([
      this.prisma.todo.groupBy({
        by: ['status'],
        where: assigned,
        _count: { _all: true },
      }),
      this.prisma.todoStatusHistory.findMany({
        where: { todo: assigned, unassignedStaffMemberId: null },
        orderBy: [{ changedAt: 'desc' }, { todoStatusHistoryId: 'desc' }],
        take: RECENT_TODO_HISTORIES,
        select: {
          todoStatusHistoryId: true,
          todoId: true,
          fromStatus: true,
          toStatus: true,
          isUrgentChanged: true,
          changedBy: true,
          staffMemberId: true,
          changedAt: true,
          todo: { select: { title: true } },
        },
      }),
    ]);
    const countOf = (done: boolean) =>
      counts
        .filter((c) => (c.status === 'DONE') === done)
        .reduce((sum, c) => sum + c._count._all, 0);
    const doneCount = countOf(true);
    const notDoneCount = countOf(false);
    return {
      total: doneCount + notDoneCount,
      doneCount,
      notDoneCount,
      recentHistories: histories.map((h) => ({
        todoStatusHistoryId: h.todoStatusHistoryId,
        todoId: h.todoId,
        title: h.todo.title,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        isUrgentChanged: h.isUrgentChanged,
        actor: actorOf(h),
        changedAt: h.changedAt,
      })),
    };
  }

  /** 그 영역 메뉴의 조회 권한(없으면 403) → 직원 범위(없으면 404) 순이다 */
  private async check(
    adminAccountId: number,
    staffMemberId: number,
    menuUrl: string,
  ): Promise<void> {
    await requireAreaRead(
      this.prisma,
      this.logger,
      adminAccountId,
      menuUrl,
      StaffMemberSummaryService.name,
    );
    if (!(await this.scope.canManageStaffMember(adminAccountId, staffMemberId)))
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
  }
}

/** 이력을 쓴 쪽 — 관리자(changed_by, 함께 있으면 관리자) · 직원(staff_member_id) · 둘 다 없으면 시스템(퇴직 배치 등) */
function actorOf(h: {
  changedBy: number | null;
  staffMemberId: number | null;
}): StatusChangeActor {
  if (h.changedBy !== null) return 'ADMIN';
  if (h.staffMemberId !== null) return 'STAFF';
  return 'SYSTEM';
}
