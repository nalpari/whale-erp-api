import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, kstDayStart, kstToday } from '../staff-members/kst-date';
import { kstTimeOf, workDateOf } from '../work-schedules/work-schedule-rules';
import { ACTIVE_STAFF } from '../todos/todo-rules';
import { schedulable } from '../work-schedules/work-schedules.service';
import { weekStats } from '../payslips/pay-calculation';
import { periodContractIds } from '../payslips/payslip-attendance-reasons';
import { payInputOf } from '../payslips/payslip-calculation';
import { editHistory } from './attendance-edit.service';
import {
  ATTENDANCE_DAY_STATUS_LABELS,
  attendanceDayStatus,
  checkOutDue,
  type AttendanceDayStatus,
  type DayPair,
} from './attendance-day-status';
import type {
  AttendanceDayItemDto,
  AttendanceHistoryEntryDto,
  AttendanceWeekStaffDto,
  AttendancePunchDto,
  AttendanceStoresQueryDto,
  DailyAttendanceResponseDto,
  MyAttendanceDayDto,
  MyAttendanceRecordsResponseDto,
  PeriodAttendanceResponseDto,
} from './dto/attendance-records.dto';

const STAFF_NOT_FOUND = '직원을 찾을 수 없습니다';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 직원 앱 기간별의 최대 일수 — 한 번에 1년(HIST-2, WHALEERP-221) */
export const MAX_MY_PERIOD_DAYS = 366;
/** 기간 조회의 최대 일수 — 관리자가 보정할 수 있는 최근 3개월(92일)을 한 번에 본다 */
export const MAX_PERIOD_DAYS = 92;
const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const PUNCH_SELECT = {
  attendanceRecordId: true,
  staffMemberId: true,
  storeId: true,
  recordedAt: true,
  reviewReason: true,
  entryMethod: true,
  _count: { select: { attendanceCorrections: true } },
} as const satisfies Prisma.AttendanceRecordSelect;

type Punch = Prisma.AttendanceRecordGetPayload<{ select: typeof PUNCH_SELECT }>;

/** 점포 조건으로 고른 점포와, 점포마다 본사에게 가려지는지 */
type Scope = {
  storeIds: number[];
  nameOf: Map<number, string>;
  hides: (storeId: number, consented: boolean) => boolean;
};

/**
 * 관리자 웹 「출·퇴근 현황 조회」(/attendance-records, MN000025, WHALEERP-217 · 219). 점포는 상단 범위 · 필터의 점포 조건이고
 * 업무 범위 밖 점포는 늘 빠진다. 본사 계정에게 동의 없는 가맹 직원은 줄째로 빼고 숫자에만 센다(ATT-30).
 */
@Injectable()
export class AttendanceRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /**
   * 하루의 출퇴근(데모 「일별 출퇴근」). 줄은 그날 근무스케줄을 받을 수 있는 직원(근무스케줄 관리와 같은 규칙)과 그날
   * 근무스케줄 · 출퇴근 기록이 있는 직원이다 — 퇴직한 직원도 그날 기록이 있으면 나온다.
   */
  async daily(
    adminAccountId: number,
    stores: AttendanceStoresQueryDto,
    dateYmd: string,
    now: Date = new Date(),
  ): Promise<DailyAttendanceResponseDto> {
    const scope = await this.scopeOf(adminAccountId, stores);
    const date = toDate(dateYmd);
    const roster = scope.storeIds.length
      ? await this.prisma.staffMember.findMany({
          where: { storeId: { in: scope.storeIds }, ...schedulable(date) },
          select: { staffMemberId: true, storeId: true },
        })
      : [];
    const { rows, counts } = await this.rows(
      scope,
      date,
      date,
      null,
      roster,
      now,
    );
    return { date: dateYmd, items: rows, counts };
  }

  /**
   * 기간의 출퇴근(WHALEERP-217 「직원별 · 근무지별 · 기간」). 줄은 직원 · 날마다 하나이고, 그날 근무스케줄이나 출퇴근 기록이
   * 있는 것만이다(휴무는 줄이 없다). 날짜 내림차순, 같은 날은 점포 · 이름순. 직원을 고르면 그 직원 레코드만 — 점포 조건 안의
   * 직원이 아니거나 본사에게 가려지는 직원이면 404.
   */
  async period(
    adminAccountId: number,
    stores: AttendanceStoresQueryDto,
    fromYmd: string,
    toYmd: string,
    staffMemberId: number | null,
    now: Date = new Date(),
  ): Promise<PeriodAttendanceResponseDto> {
    const from = toDate(fromYmd);
    const to = toDate(toYmd);
    const days = (to.getTime() - from.getTime()) / DAY_MS + 1;
    if (days < 1 || days > MAX_PERIOD_DAYS)
      throw new BadRequestException(
        `기간은 시작일부터 ${MAX_PERIOD_DAYS}일 이하입니다`,
      );
    const scope = await this.scopeOf(adminAccountId, stores);
    if (staffMemberId !== null) {
      const staff = await this.prisma.staffMember.findFirst({
        where: { staffMemberId, storeId: { in: scope.storeIds } },
        select: { storeId: true, ...HQ_SHARING_SELECT },
      });
      if (!staff || scope.hides(staff.storeId, hqSharingConsentedOf(staff)))
        throw new NotFoundException(STAFF_NOT_FOUND);
    }
    const { rows, counts } = await this.rows(
      scope,
      from,
      to,
      staffMemberId,
      [],
      now,
    );
    return {
      from: fromYmd,
      to: toYmd,
      items: await this.withEdits(
        rows.sort((a, b) => b.date.localeCompare(a.date) || rowOrder(a, b)),
      ),
      counts,
      ...(days === 7 && from.getUTCDay() === 1
        ? { weekStaff: await this.weekStaff(rows, from, to) }
        : {}),
    };
  }

  /**
   * 직원 근무 앱 출퇴근 현황(WHALEERP-221 · 222) — 내 소속 하나(앱 전역 근무지)의 기간(366일 이하) 직원 · 날 줄과, 보정 · 대신 등록한
   * 날의 이력(연필 시트, HIST-1). 내 소속이 아니면 404(소속 규칙은 `GET /me/memberships` 와 같은 ACTIVE_STAFF). 근무스케줄만 있고
   * 아직 오지 않은 날도 줄이 된다(「아직 근무 전입니다」). 날짜 오름차순.
   */
  async mine(
    accountId: number,
    staffMemberId: number,
    fromYmd: string,
    toYmd: string,
    now: Date = new Date(),
  ): Promise<MyAttendanceRecordsResponseDto> {
    const from = toDate(fromYmd);
    const to = toDate(toYmd);
    const days = (to.getTime() - from.getTime()) / DAY_MS + 1;
    if (days < 1 || days > MAX_MY_PERIOD_DAYS)
      throw new BadRequestException(
        `기간은 시작일부터 ${MAX_MY_PERIOD_DAYS}일 이하입니다`,
      );
    const member = await this.prisma.staffMember.findFirst({
      where: { staffMemberId, accountId, ...ACTIVE_STAFF },
      select: { storeId: true },
    });
    if (!member) throw new NotFoundException('소속을 찾을 수 없습니다');
    const store = await this.prisma.store.findUniqueOrThrow({
      where: { storeId: member.storeId },
      select: { name: true },
    });
    const { rows } = await this.rows(
      {
        storeIds: [member.storeId],
        nameOf: new Map([[member.storeId, store.name]]),
        hides: () => false,
      },
      from,
      to,
      staffMemberId,
      [],
      now,
    );
    const items: MyAttendanceDayDto[] = await this.withEdits(
      rows.sort((a, b) => a.date.localeCompare(b.date)),
      true,
    );
    return { from: fromYmd, to: toYmd, storeName: store.name, items };
  }

  /**
   * 근태 요약의 직원별 한 주 값 — 급여 계산(WHALEERP-227)의 입력을 그대로 만들어 근무 · 연장 · 주휴 대상을 센다. 계약은 그 주에
   * 걸친 체결 완료 계약 가운데 가장 늦게 시작한 것, 없으면 계약 요일 없이 근무 분만.
   */
  private weekStaff(
    rows: AttendanceDayItemDto[],
    from: Date,
    to: Date,
  ): Promise<AttendanceWeekStaffDto[]> {
    const staff = new Map(rows.map((r) => [r.staffMemberId, r.employmentType]));
    return Promise.all(
      [...staff].map(async ([staffMemberId, employmentType]) => {
        const [contractId] = await periodContractIds(
          this.prisma,
          staffMemberId,
          from,
          to,
        );
        const stats = weekStats(
          await payInputOf(this.prisma, {
            staffMemberId,
            contractId: contractId ?? null,
            employmentType,
            periodStartDate: from,
            periodEndDate: to,
            isPremiumApplied: true,
          }),
        );
        return {
          staffMemberId,
          workedMinutes: stats.workedMinutes,
          overtimeMinutes: stats.overtimeMinutes,
          isWeeklyHolidayEligible: stats.weeklyHoliday,
        };
      }),
    );
  }

  /** 보정 · 대신 등록한 줄에 이력을 붙인다(그 밖의 줄은 빈 배열) — 직원 앱 연필 시트 · 관리자 웹 「수정됨」 꼬리 */
  private withEdits<T extends AttendanceDayItemDto>(
    rows: T[],
    forStaff = false,
  ): Promise<(T & { edits: AttendanceHistoryEntryDto[] })[]> {
    return Promise.all(
      rows.map(async (r) => {
        const punches = r.pairs.flatMap((p) => [p.checkIn, p.checkOut]);
        const edited = punches.some(
          (p) => p && (p.isCorrected || p.entryMethod === 'PROXY'),
        );
        return {
          ...r,
          edits: edited
            ? await editHistory(
                this.prisma,
                punches.flatMap((p) => (p ? [p.attendanceRecordId] : [])),
                forStaff,
              )
            : [],
        };
      }),
    );
  }

  /**
   * 업무 범위 안에서 고른 점포(storeIds) · 점포 유형(storeTypes)을 모두 만족하는 점포(TO-DO 목록과 같다). 점포 유형은 상단
   * 범위 직영 · 가맹이라 폐점 점포는 뺀다(2026-10-22 재영). 사용 중인 관리자 계정이 아니면 403.
   */
  private async scopeOf(
    adminAccountId: number,
    query: AttendanceStoresQueryDto,
  ): Promise<Scope> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const typeOf = new Map(
      manageable.stores.map((s) => [s.storeId, s.storeTypeCode]),
    );
    const picked = [...typeOf.keys()].filter(
      (id) =>
        (!query.storeIds || query.storeIds.includes(id)) &&
        (!query.storeTypes ||
          query.storeTypes.some((type) => type === typeOf.get(id))),
    );
    const stores = picked.length
      ? await this.prisma.store.findMany({
          where: {
            storeId: { in: picked },
            ...(query.storeTypes ? { storeStatusCode: { not: 'CLOSED' } } : {}),
          },
          select: { storeId: true, name: true },
        })
      : [];
    return {
      storeIds: stores.map((s) => s.storeId),
      nameOf: new Map(stores.map((s) => [s.storeId, s.name])),
      hides: (storeId, consented) =>
        hidesPersonalData(
          manageable.roleTypeCode,
          typeOf.get(storeId),
          consented,
        ),
    };
  }

  /**
   * from ~ to(한국 날짜, 끝 포함)의 직원 · 날 줄. 출근은 기록 시각이 그날인 것이고 퇴근은 그 짝이다(자정을 넘긴 퇴근도 출근한
   * 날에 붙는다). 짝 없는 퇴근은 기록 시각이 그날인 것, 근무스케줄은 시작한 날(근무일)이다. roster 는 근무스케줄 · 기록이
   * 없어도 줄을 둘 직원이다(하루 보기의 휴무 줄). 직원 레코드는 점포마다 따로라 줄의 점포는 그 레코드의 점포다. 본사에게
   * 가려지는 직원은 줄째로 빼고 숫자에만 센다(ATT-30, 목업 STAFF-31 · WHALEERP-219) — 근무스케줄 관리(줄은 두고 이름만 비움,
   * STAFF-39)와 다르다. 출퇴근은 줄이 있으면 그 사람이 그날 일했는지가 드러난다.
   */
  private async rows(
    scope: Scope,
    from: Date,
    to: Date,
    staffMemberId: number | null,
    roster: { staffMemberId: number }[],
    now: Date,
  ) {
    const counts = Object.fromEntries(
      Object.keys(ATTENDANCE_DAY_STATUS_LABELS).map((k) => [k, 0]),
    ) as Record<AttendanceDayStatus, number>;
    if (!scope.storeIds.length) return { rows: [], counts };
    const span = { gte: kstDayStart(from), lt: kstDayStart(addDays(to, 1)) };
    const where = {
      storeId: { in: scope.storeIds },
      ...(staffMemberId === null ? {} : { staffMemberId }),
    };
    const [schedules, checkIns, orphanOuts] = await Promise.all([
      this.prisma.workSchedule.findMany({
        where: { ...where, isDeleted: false, startAt: span },
        orderBy: [{ startAt: 'asc' }, { workScheduleId: 'asc' }],
        select: {
          staffMemberId: true,
          startAt: true,
          endAt: true,
          breakMinutes: true,
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { ...where, kind: 'CHECK_IN', recordedAt: span },
        orderBy: [{ recordedAt: 'asc' }, { attendanceRecordId: 'asc' }],
        select: {
          ...PUNCH_SELECT,
          attendanceRecordsAsCheckIn: {
            orderBy: { attendanceRecordId: 'asc' },
            take: 1,
            select: PUNCH_SELECT,
          },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          ...where,
          kind: 'CHECK_OUT',
          checkInAttendanceRecordId: null,
          recordedAt: span,
        },
        orderBy: [{ recordedAt: 'asc' }, { attendanceRecordId: 'asc' }],
        select: PUNCH_SELECT,
      }),
    ]);

    /** 직원 · 날 → 그날 근무스케줄과 출근 · 퇴근 짝 */
    const days = new Map<
      string,
      {
        staffMemberId: number;
        date: string;
        schedules: (typeof schedules)[number][];
        pairs: (DayPair & { checkIn: Punch | null; checkOut: Punch | null })[];
      }
    >();
    const dayOf = (id: number, date: string) => {
      const key = `${id}|${date}`;
      let d = days.get(key);
      if (!d) {
        d = { staffMemberId: id, date, schedules: [], pairs: [] };
        days.set(key, d);
      }
      return d;
    };
    for (const r of roster) dayOf(r.staffMemberId, isoDate(from));
    for (const s of schedules)
      dayOf(s.staffMemberId, isoDate(workDateOf(s.startAt))).schedules.push(s);
    for (const r of checkIns)
      dayOf(r.staffMemberId, isoDate(kstToday(r.recordedAt))).pairs.push({
        checkIn: r,
        checkOut: r.attendanceRecordsAsCheckIn[0] ?? null,
      });
    for (const r of orphanOuts)
      dayOf(r.staffMemberId, isoDate(kstToday(r.recordedAt))).pairs.push({
        checkIn: null,
        checkOut: r,
      });

    const people = await this.prisma.staffMember.findMany({
      where: {
        staffMemberId: {
          in: [...new Set([...days.values()].map((d) => d.staffMemberId))],
        },
      },
      select: {
        staffMemberId: true,
        storeId: true,
        name: true,
        phone: true,
        employmentType: true,
        employmentStatus: true,
        ...HQ_SHARING_SELECT,
      },
    });
    const personOf = new Map(people.map((p) => [p.staffMemberId, p]));
    // 확정 · 발송된 급여명세서 기간 — 보정하면 급여에 영향이 갈 수 있다고 화면이 미리 알린다(WHALEERP-218 · 220)
    const confirmed = await this.prisma.payslip.findMany({
      where: {
        staffMemberId: { in: people.map((p) => p.staffMemberId) },
        status: { in: ['CONFIRMED', 'SENT'] },
        periodStartDate: { lte: to },
        periodEndDate: { gte: from },
      },
      select: {
        staffMemberId: true,
        periodStartDate: true,
        periodEndDate: true,
      },
    });
    const payslipConfirmed = (staffMemberId: number, date: string) =>
      confirmed.some(
        (p) =>
          p.staffMemberId === staffMemberId &&
          isoDate(p.periodStartDate) <= date &&
          isoDate(p.periodEndDate) >= date,
      );
    const today = isoDate(kstToday(now));
    const yesterday = isoDate(addDays(kstToday(now), -1));
    const todayStart = kstDayStart(kstToday(now));
    const rows: AttendanceDayItemDto[] = [];
    for (const d of days.values()) {
      const person = personOf.get(d.staffMemberId);
      if (!person) continue;
      const status = attendanceDayStatus(
        d.schedules.map((s) => s.startAt),
        d.pairs,
        checkOutDue(
          d.date,
          d.schedules.map((s) => s.endAt),
          today,
          yesterday,
          todayStart,
        ),
        now,
      );
      if (status) counts[status] += 1;
      if (scope.hides(person.storeId, hqSharingConsentedOf(person))) continue;
      rows.push({
        date: d.date,
        staffMemberId: person.staffMemberId,
        name: person.name,
        phone: person.phone,
        storeId: person.storeId,
        storeName: scope.nameOf.get(person.storeId) ?? '',
        employmentType: person.employmentType,
        employmentStatus: person.employmentStatus,
        schedules: d.schedules.map((s) => ({
          startTime: kstTimeOf(s.startAt),
          endTime: kstTimeOf(s.endAt),
          breakMinutes: s.breakMinutes,
        })),
        pairs: d.pairs.map((x) => ({
          checkIn: x.checkIn && punchOf(x.checkIn),
          checkOut: x.checkOut && punchOf(x.checkOut),
        })),
        status,
        isPayslipConfirmed: payslipConfirmed(person.staffMemberId, d.date),
      });
    }
    return { rows: rows.sort(rowOrder), counts };
  }
}

/** 점포 이름 · 직원 이름 · ID 순 */
const rowOrder = (a: AttendanceDayItemDto, b: AttendanceDayItemDto) =>
  a.storeName.localeCompare(b.storeName) ||
  a.name.localeCompare(b.name) ||
  a.staffMemberId - b.staffMemberId;

const punchOf = (r: Punch): AttendancePunchDto => ({
  attendanceRecordId: r.attendanceRecordId,
  recordedAt: r.recordedAt,
  time: kstTimeOf(r.recordedAt),
  reviewReason: r.reviewReason,
  entryMethod: r.entryMethod,
  isCorrected: r._count.attendanceCorrections > 0,
});
