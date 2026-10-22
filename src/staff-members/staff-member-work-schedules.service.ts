import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { requireAreaRead } from '../auth/menu-permission.guard';
import { dateOnly } from '../common/date-only';
import { PrismaService } from '../prisma/prisma.service';
import { kstTimeOf, workDateOf } from '../work-schedules/work-schedule-rules';
import {
  STAFF_WORK_SCHEDULE_PERIODS,
  type StaffMemberWorkScheduleListQueryDto,
  type StaffWorkSchedulePeriod,
} from './dto/staff-member-work-schedule-list.query.dto';
import type { StaffMemberWorkScheduleListResponseDto } from './dto/staff-member-work-schedule-list.response.dto';
import { addDays, addMonths, kstDayStart, kstToday } from './kst-date';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';

const DEFAULT_PAGE_SIZE = 20;

/**
 * 기간을 근무 시작 일시의 범위로 바꾼다. 근무일은 시작 일시의 한국 날짜라(근무스케줄 관리와 같다) 한국 0시로 자른다.
 * 이번 주는 오늘(한국 날짜)이 든 주의 월~일이다. 4주 · 3개월 · 1년은 오늘에서 28일 · 3개월 · 12개월 전 날짜(그날 포함)부터
 * 상한이 없다 — 미래에 잡힌 근무까지 든다(2026-10-22 노영주). 달은 addMonths 로 세어 그 달에 같은 날이 없으면 마지막 날이다
 * (5월 31일 − 3개월 = 2월 28일). 전체는 조건이 없다 — 생성일로부터 3년 지난 것은 파기 배치(work-schedule-purge)가 지운다.
 */
export function periodRange(
  period: StaffWorkSchedulePeriod,
  now: Date,
): { gte?: Date; lt?: Date } {
  const today = kstToday(now);
  switch (period) {
    case 'THIS_WEEK': {
      // getUTCDay 는 일요일이 0 — 월요일로부터 며칠 지났는지로 바꾼다
      const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
      return {
        gte: kstDayStart(monday),
        lt: kstDayStart(addDays(monday, 7)),
      };
    }
    case 'LAST_4_WEEKS':
      return { gte: kstDayStart(addDays(today, -28)) };
    case 'LAST_3_MONTHS':
      return { gte: kstDayStart(addMonths(today, -3)) };
    case 'LAST_1_YEAR':
      return { gte: kstDayStart(addMonths(today, -12)) };
    case 'ALL':
      return {};
    default: {
      // 값을 더하고 case 를 빠뜨리면 여기서 컴파일 오류다
      const unknown: never = period;
      // 컨트롤러의 검증이 막지만, 서비스를 직접 부른 잘못된 값을 다른 기간으로 바꿔 답하지 않는다(요약의 weekStart 와 같다)
      throw new BadRequestException(
        `period 는 ${STAFF_WORK_SCHEDULE_PERIODS.join(' · ')} 중 하나입니다 — ${String(unknown)}`,
      );
    }
  }
}

type Row = {
  workScheduleId: number;
  storeId: number;
  startAt: Date;
  endAt: Date;
};

/**
 * 직원 상세의 근무스케줄 표(WHALEERP-185) — 이 직원 레코드(그 점포)의 근무스케줄을 기간으로 걸러 페이지로 나눈다. 지운
 * 근무스케줄은 뺀다. 응답 순서는 가드 403(직원 정보 관리 조회) → 쿼리 400 → ID 형식 404(컨트롤러) → 영역 403(근무스케줄 관리
 * 조회, 「조회 권한이 없습니다.」, 여기) → 범위 404(여기)다. 영역 권한을 범위보다 먼저 봐서 권한이 없으면 형식이 맞는 어떤 ID 든
 * 같은 403 이다(직원 상세 요약 · 직원 TO-DO 목록과 같다). 범위는 직원 상세와 같다 — 없는 직원 · 관리 범위 밖 · 가려지는 직원은
 * 같은 404.
 */
@Injectable()
export class StaffMemberWorkSchedulesService {
  private readonly logger = new Logger(StaffMemberWorkSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  async list(
    adminAccountId: number,
    staffMemberId: number,
    query: StaffMemberWorkScheduleListQueryDto,
    now: Date = new Date(),
  ): Promise<StaffMemberWorkScheduleListResponseDto> {
    await requireAreaRead(
      this.prisma,
      this.logger,
      adminAccountId,
      '/work-schedules',
      StaffMemberWorkSchedulesService.name,
    );
    if (!(await this.scope.canManageStaffMember(adminAccountId, staffMemberId)))
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);

    const range = periodRange(query.period ?? 'THIS_WEEK', now);
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const skip = ((query.page ?? 1) - 1) * pageSize;
    // 한 WHERE 조각을 페이지와 집계가 함께 쓴다 — total · 근무시간 합계가 페이지와 같은 행을 센다
    const where = Prisma.join(
      [
        Prisma.sql`staff_member_id = ${staffMemberId}`,
        Prisma.sql`NOT is_deleted`,
        ...(range.gte ? [Prisma.sql`start_at >= ${range.gte}`] : []),
        ...(range.lt ? [Prisma.sql`start_at < ${range.lt}`] : []),
      ],
      ' AND ',
    );
    // 근무일(시작 일시의 한국 날짜) 내림차순, 같은 날은 시작 시각 오름차순이다. Prisma 의 orderBy 로는 날짜와 시각을 반대
    // 방향으로 정렬할 수 없어 SQL 로 쓴다. 같은 한국 날짜 안에서는 start_at 순서가 시작 시각 순서다.
    // 근무시간은 직원 상세 요약의 workMinutes 와 같은 식이다 — 종료 − 시작(분) − 휴게. 고른 기간 전체의 합이라 페이지와 무관하다.
    const [rows, [aggregate]] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT work_schedule_id AS "workScheduleId", store_id AS "storeId",
               start_at AS "startAt", end_at AS "endAt"
        FROM work_schedules
        WHERE ${where}
        ORDER BY (start_at AT TIME ZONE 'Asia/Seoul')::date DESC, start_at ASC, work_schedule_id ASC
        LIMIT ${pageSize} OFFSET ${skip}
      `),
      // COUNT 는 bigint, SUM(numeric) 은 numeric 이라 그대로면 BigInt · Decimal 로 온다 — 숫자로 바꿔 받는다
      this.prisma.$queryRaw<{ total: number; totalWorkMinutes: number }[]>(
        Prisma.sql`
          SELECT COUNT(*)::int AS total,
                 COALESCE(SUM(EXTRACT(EPOCH FROM (end_at - start_at)) / 60 - break_minutes), 0)::float8 AS "totalWorkMinutes"
          FROM work_schedules
          WHERE ${where}
        `,
      ),
    ]);
    const { total, totalWorkMinutes } = aggregate;
    if (rows.length === 0) return { items: [], total, totalWorkMinutes };

    // stores 는 1팀 테이블이라 Prisma 관계가 없다 — 점포 id 로 따로 묻는다
    const stores = await this.prisma.store.findMany({
      where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
      select: { storeId: true, name: true },
    });
    const nameOf = new Map(stores.map((s) => [s.storeId, s.name]));
    const items = rows.map((r) => {
      const storeName = nameOf.get(r.storeId);
      // 근무스케줄의 점포는 외래키로 묶여 있다. 못 찾으면 데이터가 깨진 것이라 빈 칸으로 내보내지 않는다(직원 상세 요약과 같다)
      if (storeName === undefined) {
        this.logger.error(
          `근무스케줄 ${r.workScheduleId} 의 점포 ${r.storeId} 를 찾을 수 없습니다(직원 ${staffMemberId})`,
        );
        throw new InternalServerErrorException(
          `근무스케줄 ${r.workScheduleId} 의 점포 ${r.storeId} 를 찾을 수 없습니다`,
        );
      }
      return {
        workScheduleId: r.workScheduleId,
        workDate: dateOnly(workDateOf(r.startAt)),
        storeName,
        startTime: kstTimeOf(r.startAt),
        endTime: kstTimeOf(r.endAt),
      };
    });
    return { items, total, totalWorkMinutes };
  }
}
