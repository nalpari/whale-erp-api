import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, kstDayStart } from '../staff-members/kst-date';
import { STAFF_NOT_FOUND_MESSAGE } from '../staff-members/staff-menu';
import {
  BulkCreateWorkSchedulesDto,
  CopyLastWeekResponseDto,
  CopyLastWeekStaffDto,
  BulkCreateWorkSchedulesResponseDto,
  BulkWorkScheduleFailureDto,
  CreateWorkScheduleDto,
  UpdateWorkScheduleDto,
  WorkScheduleDefaultsDto,
  WorkScheduleDeleteResponseDto,
  WorkScheduleDto,
  WorkScheduleFieldsDto,
  WorkScheduleListResponseDto,
  WorkScheduleRosterItemDto,
  WorkScheduleStaffResponseDto,
} from './dto/work-schedule.dto';
import { noticeScheduleChange } from './work-schedule-notice';
import {
  breakFits,
  coverageOf,
  defaultsOf,
  kstTimeOf,
  type Span,
  toSpan,
  weekdayOf,
  workDateOf,
} from './work-schedule-rules';

const SCHEDULE_NOT_FOUND = '근무스케줄을 찾을 수 없습니다';
const STORE_NOT_FOUND = '근무지 점포를 찾을 수 없습니다';

const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const DAY_MS = 24 * 60 * 60 * 1000;
/** 조회 기간의 최대 일수 — 월간 달력 6주 */
const MAX_LIST_DAYS = 42;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

type Tx = Prisma.TransactionClient;

type Scope = {
  storeIds: number[];
  hide: (storeId: number, isHqSharingConsented: boolean) => boolean;
  storeHides: (storeId: number) => boolean | null;
};

/**
 * 근무일을 덮는 체결 완료 근로계약(운영 정책 PAY-11 v182 · STAFF-29). 「체결 완료 근로계약 기간」은 한 번이라도 체결된
 * 계약의 기간이다(2026-10-21 재영 A안) — 지금 체결 완료이거나, 체결된 뒤 대체 · 만료로 종료(ENDED)된 계약. 체결을 거쳤는지는
 * 상태 이력의 SIGNED 로 본다(종이 계약은 등록 때, 전자계약은 날인 때 남는다). 날인 전에 종료 · 거부 · 만료된 계약은 넣지
 * 않는다. 지금 체결 완료인 계약은 이력을 보지 않는다 — 이력 없이 넣은 데이터도 빠지지 않게.
 *
 * 기간의 끝은 종료일이다. 종료일이 비면 체결 완료는 기간의 정함이 없고, 종료된 계약은 종료 처리한 날(ENDED 로 바뀐 시각의
 * 한국 날짜)이 끝이다(2026-10-21 재영, PAY-11 v182) — 「근무일 ≤ 그 날짜」는 「ENDED 로 바뀐 시각 ≥ 근무일 한국 0시」와 같다.
 */
const contractCovers = (workDate: Date) => {
  const signedOnce = {
    status: 'ENDED',
    contractStatusHistories: { some: { toStatus: 'SIGNED' } },
  } as const satisfies Prisma.ContractWhereInput;
  return {
    startDate: { lte: workDate },
    OR: [
      { status: 'SIGNED', endDate: null },
      { status: 'SIGNED', endDate: { gte: workDate } },
      { ...signedOnce, endDate: { gte: workDate } },
      {
        AND: [
          { ...signedOnce, endDate: null },
          {
            contractStatusHistories: {
              some: {
                toStatus: 'ENDED',
                changedAt: { gte: kstDayStart(workDate) },
              },
            },
          },
        ],
      },
    ],
  } as const satisfies Prisma.ContractWhereInput;
};

/**
 * 그 근무일에 근무스케줄을 받을 수 있는 직원 레코드 — 가입을 마쳤고(종이 계약으로 체결 완료여도 가입 전이면 뺀다, TO-DO 와
 * 같다), 근무일을 덮는 체결 완료 계약이 있고, 퇴직일이 정해졌으면 근무일이 퇴직일 이하다(CTR-24, 2026-10-21 재영). 지난
 * 날짜에 퇴직한 직원의 재직 중 날짜는 받는다(지난 날짜도 고친다, 결정 9). 등록 · 수정 · 선택지가 모두 이것을 쓴다.
 */
const schedulable = (workDate: Date) =>
  ({
    joinStatus: 'JOINED',
    contracts: { some: contractCovers(workDate) },
    OR: [{ retiredDate: null }, { retiredDate: { gte: workDate } }],
  }) as const satisfies Prisma.StaffMemberWhereInput;

const SCHEDULE_SELECT = {
  workScheduleId: true,
  staffMemberId: true,
  storeId: true,
  startAt: true,
  endAt: true,
  breakMinutes: true,
} as const satisfies Prisma.WorkScheduleSelect;

type ScheduleRow = Prisma.WorkScheduleGetPayload<{
  select: typeof SCHEDULE_SELECT;
}>;

/** 변경 이력의 값 — 퇴직 처리의 삭제 이력과 같은 모양 */
const historyValue = (
  r: Pick<ScheduleRow, 'startAt' | 'endAt' | 'breakMinutes'>,
) => ({
  startAt: r.startAt.toISOString(),
  endAt: r.endAt.toISOString(),
  breakMinutes: r.breakMinutes,
});

const toDto = (r: ScheduleRow): WorkScheduleDto => ({
  workScheduleId: r.workScheduleId,
  staffMemberId: r.staffMemberId,
  storeId: r.storeId,
  workDate: isoDate(workDateOf(r.startAt)),
  startTime: kstTimeOf(r.startAt),
  endTime: kstTimeOf(r.endAt),
  startAt: r.startAt.toISOString(),
  endAt: r.endAt.toISOString(),
  breakMinutes: r.breakMinutes,
});

/** 휴게를 뺀 근무 분 */
const workedMinutes = (
  r: Pick<ScheduleRow, 'startAt' | 'endAt' | 'breakMinutes'>,
) => (r.endAt.getTime() - r.startAt.getTime()) / 60_000 - r.breakMinutes;

/** 근무일 · 분을 모은다 — 같은 날 쪼갠 근무는 하루로 센다 */
class Tally {
  private readonly dates = new Set<string>();
  private minutes = 0;
  add(r: Pick<ScheduleRow, 'startAt'>, minutes: number): void {
    this.dates.add(isoDate(workDateOf(r.startAt)));
    this.minutes += minutes;
  }
  toDto(): { days: number; minutes: number } {
    return { days: this.dates.size, minutes: this.minutes };
  }
}

/** HttpException 응답의 code — 없으면 null */
function codeOf(error: HttpException): string | null {
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body
    ? String(body.code)
    : null;
}

/** 그 근무일이 든 주의 월요일 */
const mondayOf = (date: Date) => addDays(date, -((date.getUTCDay() + 6) % 7));

/**
 * 점포 · 주의 advisory lock 키. 지난 주 복사는 배타로, 한 건 · 일괄 등록 · 수정은 넣을 주에 공유로 잡는다 — 복사가 빈 주를
 * 센 뒤 다른 등록이 그 주에 끼어들지 못하게(PAY-13 「빈 주에서만」, api #110 리뷰). 직원 행보다 먼저 잡는다(교착 방지).
 */
const weekKey = (storeId: number, date: Date) =>
  `work-schedule-week:${storeId}:${isoDate(mondayOf(date))}`;

/** 지난 주 복사 트랜잭션의 시간 제한 */
const COPY_TIMEOUT_MS = 30_000;

const copyHiddenStaff = () =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'WORK_SCHEDULE_COPY_HIDDEN_STAFF',
    message:
      '본사 계정은 이 점포의 지난 주 복사를 할 수 없습니다 — 가맹 점포 관리자가 복사해 주세요',
  });

const overlap = () =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'WORK_SCHEDULE_OVERLAP',
    message: '같은 직원의 근무스케줄과 시간이 겹칩니다',
  });

/** 동시 저장이 DB 의 겹침 금지(work_schedules_no_overlap, EXCLUDE)에 걸렸는가 — PostgreSQL 23P01 */
const isOverlapViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError) &&
  error.message.includes('work_schedules_no_overlap');

/**
 * 관리자 웹 근무스케줄 관리(#198). 업무 범위(관리하는 점포) 밖 직원 · 근무스케줄은 없는 것과 같다(404).
 *
 * 받는 값은 근무일 · 시작 · 종료 · 휴게다. 종료가 시작보다 이르면 다음 날이고(자정 넘김), 근무일은 늘 시작 일시의 한국
 * 날짜다(2026-10-21 재영 결정 1). 겹침은 같은 직원 레코드끼리만 막는다 — 직원 레코드는 점포마다 따로라 같은 점포 안이다
 * (결정 3). DB 의 EXCLUDE 가 최종으로 막고, 서버는 먼저 찾아 같은 409 를 준다. 지난 날짜도 경고 없이 받는다(결정 9) —
 * 근무스케줄은 급여 계산에 쓰지 않는다(결정 8, PAY-12). 저장할 때마다 그 직원에게 저장 알림을 한 번 만든다(#201, work-schedule-notice.ts).
 */
@Injectable()
export class WorkSchedulesService {
  private readonly logger = new Logger(WorkSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /**
   * 주간 · 월간 보기(#343 · #202). 날마다 「받을 수 있는 직원」을 같은 판정(schedulable)으로 찾아 행을 만들고, 그 날짜의
   * 근무스케줄만 낸다 — 계약이 끝나 받을 수 없게 된 날의 근무스케줄은 행이 없으니 내지 않는다(STAFF-29). 본사 계정이 가맹
   * 점포를 보면 동의 없는 직원은 행을 두되 누구인지 비우고 근무스케줄을 내지 않는다. 인원(headcount · coverage)에는 센다
   * (결정 7 · ATT-30). ponytail: 날마다 쿼리 한 번(전날 포함 최대 43번, 차례로) — 판정을 한 곳에만 두려고. 느려지면 계약 · 이력을 한 번 읽어
   * 판정한다.
   */
  async list(
    adminAccountId: number,
    storeId: number,
    fromYmd: string,
    toYmd: string,
  ): Promise<WorkScheduleListResponseDto> {
    const from = toDate(fromYmd);
    const to = toDate(toYmd);
    const dayCount = (to.getTime() - from.getTime()) / DAY_MS + 1;
    if (dayCount < 1 || dayCount > MAX_LIST_DAYS)
      throw new BadRequestException(
        `기간은 시작 근무일부터 ${MAX_LIST_DAYS}일 이하입니다`,
      );
    const scope = await this.scopeOf(adminAccountId);
    if (scope.storeHides(storeId) === null)
      throw new NotFoundException(STORE_NOT_FOUND);

    const dates = Array.from({ length: dayCount }, (_, i) => addDays(from, i));
    // 첫날 새벽 칸에는 전날 시작해 자정을 넘은 근무도 센다(Q4) — 판정 · 읽기를 하루 앞에서 시작한다
    const judged = [addDays(from, -1), ...dates];
    // 차례로 돈다 — 한꺼번에 던지면 월간 조회 하나가 연결 풀을 다 잡는다(api 리뷰)
    const perDay: { staffMemberId: number }[][] = [];
    for (const d of judged)
      perDay.push(
        await this.prisma.staffMember.findMany({
          where: { storeId, ...schedulable(d) },
          select: { staffMemberId: true },
        }),
      );
    /** 직원 → 받을 수 있는 근무일(전날 포함) */
    const datesOf = new Map<number, Set<string>>();
    perDay.forEach((rows, i) => {
      for (const { staffMemberId } of rows) {
        const set = datesOf.get(staffMemberId) ?? new Set<string>();
        set.add(isoDate(judged[i]));
        datesOf.set(staffMemberId, set);
      }
    });
    const inRange = new Set(dates.map(isoDate));
    /** 기간 안 하루라도 받을 수 있는 직원 — 행이 된다. 전날만 받을 수 있던 직원은 칸 인원에만 들어간다 */
    const rosterIds = [...datesOf]
      .filter(([, set]) => [...set].some((d) => inRange.has(d)))
      .map(([id]) => id);

    const [people, schedules] = await Promise.all([
      this.prisma.staffMember.findMany({
        where: { staffMemberId: { in: rosterIds } },
        select: {
          staffMemberId: true,
          name: true,
          phone: true,
          jobTitle: true,
          employmentType: true,
          ...HQ_SHARING_SELECT,
        },
        orderBy: [{ name: 'asc' }, { staffMemberId: 'asc' }],
      }),
      this.prisma.workSchedule.findMany({
        where: {
          storeId,
          isDeleted: false,
          staffMemberId: { in: [...datesOf.keys()] },
          startAt: {
            gte: kstDayStart(judged[0]),
            lt: kstDayStart(addDays(to, 1)),
          },
        },
        select: SCHEDULE_SELECT,
        orderBy: [{ startAt: 'asc' }, { workScheduleId: 'asc' }],
      }),
    ]);
    const masked = new Set(
      people
        .filter((p) => scope.hide(storeId, hqSharingConsentedOf(p)))
        .map((p) => p.staffMemberId),
    );
    // 그 직원이 그날 받을 수 있는 근무스케줄만(Q6, STAFF-29)
    const dateOf = (r: ScheduleRow) => isoDate(workDateOf(r.startAt));
    const valid = schedules.filter((r) =>
      datesOf.get(r.staffMemberId)?.has(dateOf(r)),
    );

    const roster = (p: (typeof people)[number]): WorkScheduleRosterItemDto => {
      const schedulableDates = [...(datesOf.get(p.staffMemberId) ?? [])]
        .filter((d) => inRange.has(d))
        .sort();
      return masked.has(p.staffMemberId)
        ? {
            staffMemberId: null,
            name: null,
            phoneLast4: null,
            jobTitle: null,
            employmentType: null,
            isMasked: true,
            schedulableDates,
          }
        : {
            staffMemberId: p.staffMemberId,
            name: p.name,
            phoneLast4: p.phone.slice(-4),
            jobTitle: p.jobTitle,
            employmentType: p.employmentType,
            isMasked: false,
            schedulableDates,
          };
    };
    return {
      storeId,
      from: fromYmd,
      to: toYmd,
      // 가린 행은 뒤에, 그 안은 받을 수 있는 날짜로 — 이름순이면 명단을 아는 사람이 자리로 누구인지 맞춘다. 가린 행이 보이는
      // 것은 날짜뿐이라, 날짜까지 같은 두 행의 순서는 아무것도 드러내지 않는다
      staff: [
        ...people.filter((p) => !masked.has(p.staffMemberId)).map(roster),
        ...people
          .filter((p) => masked.has(p.staffMemberId))
          .map(roster)
          .sort((x, y) =>
            x.schedulableDates.join().localeCompare(y.schedulableDates.join()),
          ),
      ],
      items: valid
        .filter((r) => inRange.has(dateOf(r)) && !masked.has(r.staffMemberId))
        .map(toDto),
      days: dates.map((d) => {
        const ymd = isoDate(d);
        const prev = isoDate(addDays(d, -1));
        const ofDay = valid.filter((r) => dateOf(r) === ymd);
        return {
          workDate: ymd,
          // 근무 인원 수는 근무일(시작한 날)로 센다
          headcount: new Set(ofDay.map((r) => r.staffMemberId)).size,
          // 칸 인원은 그날 시작한 근무 + 전날 시작해 자정을 넘어온 근무(Q4). 화면 막대는 시작한 날에만 그린다
          coverage: coverageOf(d, [
            ...ofDay,
            ...valid.filter((r) => dateOf(r) === prev),
          ]),
        };
      }),
    };
  }

  /** 등록의 직원 선택지. 그 근무일에 받을 수 있는 직원을 이름순으로. 본사 계정이 가맹 점포를 보면 동의한 직원만(ATT-30) */
  async assignableStaff(
    adminAccountId: number,
    storeId: number,
    workDate: string,
  ): Promise<WorkScheduleStaffResponseDto> {
    const hidesStore = (await this.scopeOf(adminAccountId)).storeHides(storeId);
    if (hidesStore === null) throw new NotFoundException(STORE_NOT_FOUND);
    const rows = await this.prisma.staffMember.findMany({
      where: {
        storeId,
        ...schedulable(toDate(workDate)),
        ...(hidesStore ? HQ_SHARING_CONSENTED : {}),
      },
      select: { staffMemberId: true, name: true, phone: true, jobTitle: true },
      orderBy: [{ name: 'asc' }, { staffMemberId: 'asc' }],
    });
    return {
      items: rows.map(({ phone, ...r }) => ({
        ...r,
        phoneLast4: phone.slice(-4),
      })),
    };
  }

  /**
   * 기본값 — 근무일을 덮는 체결 완료 계약의 그 요일 근무시간(STAFF-14). 「계약 값으로 되돌리기」도 이것을 다시 부른다.
   * 그 요일이 계약 근무일이 아니면 빈 값이다. 받을 수 없는 직원이면 등록과 같은 400 이다.
   */
  async defaults(
    adminAccountId: number,
    staffMemberId: number,
    workDate: string,
  ): Promise<WorkScheduleDefaultsDto> {
    const date = toDate(workDate);
    const staff = await this.staffFor(
      this.prisma,
      await this.scopeOf(adminAccountId),
      staffMemberId,
      date,
    );
    const day = await this.prisma.contractWorkDay.findUnique({
      where: {
        contractId_weekday: {
          contractId: staff.contractId,
          weekday: weekdayOf(date),
        },
      },
      select: {
        startTime: true,
        endTime: true,
        breakStartTime: true,
        breakEndTime: true,
      },
    });
    return day
      ? defaultsOf(day)
      : { startTime: null, endTime: null, breakMinutes: null };
  }

  /** 등록 → 변경 이력 CREATED. 기본값이 된 계약을 한 번 남긴다(STAFF-14) */
  async create(
    adminAccountId: number,
    dto: CreateWorkScheduleDto,
  ): Promise<WorkScheduleDto> {
    const { date, span } = spanOf(dto);
    const scope = await this.scopeOf(adminAccountId);
    return this.save(async (tx) => {
      const row = await this.insert(tx, scope, adminAccountId, {
        staffMemberId: dto.staffMemberId,
        date,
        span,
        breakMinutes: dto.breakMinutes,
      });
      await noticeScheduleChange(tx, this.logger, {
        staffMemberId: row.staffMemberId,
        workScheduleId: row.workScheduleId,
        changes: [{ kind: 'CREATED', after: row }],
      });
      return toDto(row);
    });
  }

  /**
   * 여러 직원 일괄 등록(#199). 줄마다 한 건 등록과 같은 규칙 · 같은 트랜잭션으로 따로 저장한다 — 한 줄이 실패해도 앞뒤 줄은
   * 그대로 두고 실패한 줄을 알린다. 예상 못 한 오류도 그 줄의 실패(500)로 남기고 계속하므로 created · failed 가 그 줄들의 저장 결과를 그대로 보인다(커밋 뒤 응답 전에 끊기면 화면은 모른다 — 다시 불러 확인한다). 저장 한 번이라 알림은 다 저장한 뒤 바뀐 직원마다 한 번이다(같은 직원의 쪼갠 근무는 한
   * 알림에 묶는다, #201). 줄 순서대로 저장하므로 같은 직원의 겹치는 두 줄은 뒤 줄이 409 로 실패한다.
   */
  async bulkCreate(
    adminAccountId: number,
    dto: BulkCreateWorkSchedulesDto,
  ): Promise<BulkCreateWorkSchedulesResponseDto> {
    const scope = await this.scopeOf(adminAccountId);
    const created: ScheduleRow[] = [];
    const failed: BulkWorkScheduleFailureDto[] = [];
    for (const [index, line] of dto.rows.entries()) {
      try {
        const { date, span } = spanOf({ ...line, workDate: dto.workDate });
        created.push(
          await this.save((tx) =>
            this.insert(tx, scope, adminAccountId, {
              staffMemberId: line.staffMemberId,
              date,
              span,
              breakMinutes: line.breakMinutes,
            }),
          ),
        );
      } catch (error) {
        // 업무 규칙(400 · 404 · 409)이 아닌 오류(트랜잭션 시간 초과 · 연결 등)도 그 줄의 실패로 남기고 다음 줄로 간다 —
        // 던지면 앞 줄은 저장됐는데 알림이 빠지고 화면은 500 만 받아, 다시 보내면 저장된 줄이 겹침 409 로 보인다(api 리뷰)
        if (!(error instanceof HttpException)) {
          this.logger.error(
            `work schedule bulk row ${index} FAILED staffMember ${line.staffMemberId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          failed.push({
            index,
            staffMemberId: line.staffMemberId,
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            code: 'WORK_SCHEDULE_SAVE_FAILED',
            message: '저장하지 못했습니다. 이 줄만 다시 시도해 주세요',
          });
          continue;
        }
        failed.push({
          index,
          staffMemberId: line.staffMemberId,
          statusCode: error.getStatus(),
          code: codeOf(error),
          message: error.message,
        });
      }
    }

    // 직원마다 한 번. 근무스케줄은 이미 저장됐으니 알림이 실패해도 저장을 되돌리지 않는다 — 로그만 남긴다
    const byStaff = new Map<number, ScheduleRow[]>();
    for (const row of created)
      byStaff.set(row.staffMemberId, [
        ...(byStaff.get(row.staffMemberId) ?? []),
        row,
      ]);
    for (const [staffMemberId, rows] of byStaff) {
      try {
        await this.prisma.$transaction((tx) =>
          noticeScheduleChange(tx, this.logger, {
            staffMemberId,
            workScheduleId: rows[0].workScheduleId,
            changes: rows.map((after) => ({ kind: 'CREATED', after })),
          }),
        );
      } catch (error) {
        this.logger.error(
          `work schedule notice FAILED staffMember ${staffMemberId} after bulk save: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { created: created.map(toDto), failed };
  }

  /**
   * 지난 주 복사(#200 · STAFF-13). `apply` 가 false 면 미리보기(쓰지 않음), true 면 복사다. 넣을 주(`weekStart` 월요일부터
   * 7일)가 그 점포에서 비어 있어야 하고(아니면 409), 원본은 직전 주 고정이다. 원본 한 건마다 근무일 +7일 · 같은 시각 · 같은
   * 휴게로 만들고, 한 건 등록과 같은 판정에 걸린 건만 뺀다 — 그 직원의 다른 날은 복사한다. 지난 주에 없던 직원은 넣지 않고
   * `newcomers` 로 알린다.
   *
   * 복사는 트랜잭션 하나다. 점포 · 주 단위 advisory lock 을 잡고 빈 주를 다시 본 뒤 차례로 넣는다 — 두 번 눌러도 한 번만
   * 들어간다. 넣을 때 다시 판정하므로 미리보기 뒤 바뀐 건은 빠진다. 알림은 같은 트랜잭션에서 복사로 생긴 직원마다 한 번이다.
   */
  async copyLastWeek(
    adminAccountId: number,
    storeId: number,
    weekStartYmd: string,
    apply: boolean,
  ): Promise<CopyLastWeekResponseDto> {
    const monday = toDate(weekStartYmd);
    if (monday.getUTCDay() !== 1)
      throw new BadRequestException('weekStart 는 월요일입니다');
    const scope = await this.scopeOf(adminAccountId);
    if (scope.storeHides(storeId) === null)
      throw new NotFoundException(STORE_NOT_FOUND);
    const sourceMonday = addDays(monday, -7);

    const run = async (db: Tx): Promise<CopyLastWeekResponseDto> => {
      if (apply)
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${weekKey(storeId, monday)}))`;
      const taken = await db.workSchedule.count({
        where: {
          storeId,
          isDeleted: false,
          startAt: {
            gte: kstDayStart(monday),
            lt: kstDayStart(addDays(monday, 7)),
          },
        },
      });
      if (taken > 0)
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: 'WORK_SCHEDULE_WEEK_NOT_EMPTY',
          message:
            '이미 근무스케줄이 있는 주입니다 — 지난 주 복사는 빈 주에서만 합니다',
        });

      const sources = await db.workSchedule.findMany({
        where: {
          storeId,
          isDeleted: false,
          startAt: {
            gte: kstDayStart(sourceMonday),
            lt: kstDayStart(monday),
          },
        },
        select: SCHEDULE_SELECT,
        orderBy: [{ startAt: 'asc' }, { workScheduleId: 'asc' }],
      });
      const sourceIds = [...new Set(sources.map((r) => r.staffMemberId))];
      // 넣기 전에 원본 직원 행을 ID 순으로 한꺼번에 잠근다 — 같은 점포의 다른 주를 동시에 복사하거나 TO-DO 등록(그 점포 직원
      // 행 전부를 ID 순으로 FOR SHARE)과 겹쳐도 순서가 같아 교착하지 않는다(api #110 리뷰). 본사 제공 동의 · 퇴직일은 잠근 뒤
      // 읽는다 — 그사이 동의를 철회해도 가린 직원의 이름 · 퇴직일이 응답에 나가지 않게
      if (apply && sourceIds.length > 0)
        await db.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id IN (${Prisma.join([...sourceIds].sort((a, b) => a - b))}) ORDER BY staff_member_id FOR NO KEY UPDATE`;
      const people = new Map(
        (
          await db.staffMember.findMany({
            where: { staffMemberId: { in: sourceIds } },
            select: {
              staffMemberId: true,
              name: true,
              retiredDate: true,
              ...HQ_SHARING_SELECT,
            },
          })
        ).map((p) => [p.staffMemberId, p]),
      );
      // 본사 계정은 원본 주에 가려진 직원(본사 제공 동의 없는 가맹 직원)이 있으면 복사하지 못한다 — 그 직원만 빠져 빈 주가
      // 망가지지 않게, 가맹 점포 관리자가 복사한다(Q9, 2026-10-21 재영 · 운영 정책 PAY-13). 미리보기도 막는다 — 가린 줄을
      // 보이면 몇 명인지 드러난다. 누가 · 몇 명인지는 알리지 않는다
      if (
        [...people.values()].some((p) =>
          scope.hide(storeId, hqSharingConsentedOf(p)),
        ) ||
        sourceIds.some((id) => !people.has(id))
      )
        throw copyHiddenStaff();

      const lines = new Map<
        number,
        {
          head: Omit<CopyLastWeekStaffDto, 'source' | 'copied'>;
          source: Tally;
          copied: Tally;
        }
      >();
      const createdOf = new Map<number, ScheduleRow[]>();
      for (const r of sources) {
        let line = lines.get(r.staffMemberId);
        if (!line) {
          const person = people.get(r.staffMemberId)!;
          line = {
            head: {
              staffMemberId: r.staffMemberId,
              name: person.name,
              retiredDate: person.retiredDate
                ? isoDate(person.retiredDate)
                : null,
              excluded: [],
            },
            source: new Tally(),
            copied: new Tally(),
          };
          lines.set(r.staffMemberId, line);
        }
        const minutes = workedMinutes(r);
        line.source.add(r, minutes);

        const date = addDays(workDateOf(r.startAt), 7);
        const span = {
          startAt: addDays(r.startAt, 7),
          endAt: addDays(r.endAt, 7),
        };
        try {
          if (apply) {
            const row = await this.insert(db, scope, adminAccountId, {
              staffMemberId: r.staffMemberId,
              date,
              span,
              breakMinutes: r.breakMinutes,
            });
            createdOf.set(r.staffMemberId, [
              ...(createdOf.get(r.staffMemberId) ?? []),
              row,
            ]);
          } else {
            await this.staffFor(db, scope, r.staffMemberId, date);
            await this.checkOverlap(db, r.staffMemberId, span);
          }
          line.copied.add(span, minutes);
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          // 넣는 사이 본사 제공 동의가 철회됐다 — 그 직원만 빼지 않고 복사 전체를 막는다(Q9)
          if (codeOf(error) === 'WORK_SCHEDULE_HIDDEN') throw copyHiddenStaff();
          // 날짜 단위로 모은다 — 같은 날 쪼갠 근무가 둘 다 빠져도 한 번이다. 그날 일부만 복사되면 copied 와 함께 나온다
          const workDate = isoDate(date);
          if (!line.head.excluded.some((e) => e.workDate === workDate))
            line.head.excluded.push({ workDate, code: codeOf(error) });
        }
      }

      for (const [staffMemberId, rows] of createdOf)
        await noticeScheduleChange(db, this.logger, {
          staffMemberId,
          workScheduleId: rows[0].workScheduleId,
          changes: rows.map((after) => ({ kind: 'CREATED', after })),
        });

      // 이번 주에 받을 수 있지만 지난 주에 없던 직원 — 「지난 주 없음 · 따로 넣는다」
      const fresh = new Set<number>();
      for (let i = 0; i < 7; i += 1)
        for (const { staffMemberId } of await db.staffMember.findMany({
          where: {
            storeId,
            ...schedulable(addDays(monday, i)),
            staffMemberId: { notIn: sourceIds },
          },
          select: { staffMemberId: true },
        }))
          fresh.add(staffMemberId);
      const newcomers = await db.staffMember.findMany({
        where: { staffMemberId: { in: [...fresh] } },
        select: { staffMemberId: true, name: true, ...HQ_SHARING_SELECT },
        orderBy: [{ name: 'asc' }, { staffMemberId: 'asc' }],
      });

      return {
        storeId,
        sourceWeekStart: isoDate(sourceMonday),
        weekStart: weekStartYmd,
        staff: [...lines.values()]
          .map(({ head, source, copied }) => ({
            ...head,
            source: source.toDto(),
            copied: copied.toDto(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        // 본사에게 가려진 직원은 어차피 넣을 수 없으니 뺀다 — 몇 명인지도 드러나지 않게
        newcomers: newcomers
          .filter((p) => !scope.hide(storeId, hqSharingConsentedOf(p)))
          .map(({ staffMemberId, name }) => ({ staffMemberId, name })),
      };
    };
    // 복사는 수십 명 × 6일을 한 트랜잭션에 넣는다 — 기본 5초로는 모자랄 수 있다
    return apply
      ? this.save(run, { timeout: COPY_TIMEOUT_MS })
      : run(this.prisma);
  }

  /**
   * 한 건 등록의 몸통 — 받을 수 있는 직원인지(직원 행을 잠그고), 겹치는지 보고 저장 · 등록 이력을 남긴다. 알림은 부르는 쪽이
   * 저장 한 번에 맞춰 보낸다.
   */
  private async insert(
    tx: Tx,
    scope: Scope,
    adminAccountId: number,
    input: {
      staffMemberId: number;
      date: Date;
      span: Span;
      breakMinutes: number;
    },
  ): Promise<ScheduleRow> {
    // 넣을 주의 공유 잠금을 직원 행보다 먼저 — 지난 주 복사(배타)가 빈 주를 센 뒤 끼어들지 않고, 잠금 순서가 복사와 같다.
    // 점포는 직원 레코드마다 정해져 바뀌지 않으니 잠그지 않고 읽는다(없는 직원이면 staffFor 가 404)
    const home = await tx.staffMember.findUnique({
      where: { staffMemberId: input.staffMemberId },
      select: { storeId: true },
    });
    if (home)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${weekKey(home.storeId, input.date)}))`;
    const staff = await this.staffFor(
      tx,
      scope,
      input.staffMemberId,
      input.date,
      true,
    );
    await this.checkOverlap(tx, input.staffMemberId, input.span);
    const row = await tx.workSchedule.create({
      data: {
        staffMemberId: input.staffMemberId,
        storeId: staff.storeId,
        ...input.span,
        breakMinutes: input.breakMinutes,
        sourceContractId: staff.contractId,
        createdBy: adminAccountId,
      },
      select: SCHEDULE_SELECT,
    });
    await tx.workScheduleHistory.create({
      data: {
        workScheduleId: row.workScheduleId,
        changeType: 'CREATED',
        afterValue: historyValue(row),
        changedBy: adminAccountId,
      },
    });
    return row;
  }

  /** 수정 → 변경 이력 UPDATED(변경 전후). 바뀐 근무일로 계약 기간 · 퇴직일 · 겹침을 다시 본다 */
  async update(
    adminAccountId: number,
    workScheduleId: number,
    dto: UpdateWorkScheduleDto,
  ): Promise<WorkScheduleDto> {
    const { date, span } = spanOf(dto);
    const scope = await this.scopeOf(adminAccountId);
    return this.save(async (tx) => {
      // 옮겨 갈 주의 공유 잠금을 먼저(insert 와 같다) — 범위 · 존재는 lockSchedule 이 본다
      const home = await tx.workSchedule.findUnique({
        where: { workScheduleId },
        select: { storeId: true },
      });
      if (home)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${weekKey(home.storeId, date)}))`;
      const before = await this.lockSchedule(tx, scope, workScheduleId);
      // 직원 행은 lockSchedule 이 이미 잠갔다
      await this.staffFor(tx, scope, before.staffMemberId, date);
      await this.checkOverlap(tx, before.staffMemberId, span, workScheduleId);
      const row = await tx.workSchedule.update({
        where: { workScheduleId },
        data: { ...span, breakMinutes: dto.breakMinutes },
        select: SCHEDULE_SELECT,
      });
      await tx.workScheduleHistory.create({
        data: {
          workScheduleId,
          changeType: 'UPDATED',
          beforeValue: historyValue(before),
          afterValue: historyValue(row),
          changedBy: adminAccountId,
        },
      });
      await noticeScheduleChange(tx, this.logger, {
        staffMemberId: row.staffMemberId,
        workScheduleId,
        changes: [{ kind: 'UPDATED', before, after: row }],
      });
      return toDto(row);
    });
  }

  /** 삭제(is_deleted) → 변경 이력 DELETED(변경 전). 계약 · 퇴직 조건은 보지 않는다 */
  async remove(
    adminAccountId: number,
    workScheduleId: number,
  ): Promise<WorkScheduleDeleteResponseDto> {
    const scope = await this.scopeOf(adminAccountId);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockSchedule(tx, scope, workScheduleId);
      await tx.workSchedule.update({
        where: { workScheduleId },
        data: { isDeleted: true },
      });
      await tx.workScheduleHistory.create({
        data: {
          workScheduleId,
          changeType: 'DELETED',
          beforeValue: historyValue(before),
          changedBy: adminAccountId,
        },
      });
      // 지운 근무스케줄도 그 직원에게는 변경이다(#201)
      await noticeScheduleChange(tx, this.logger, {
        staffMemberId: before.staffMemberId,
        workScheduleId,
        changes: [{ kind: 'DELETED', before }],
      });
      return { workScheduleId };
    });
  }

  /** 저장 트랜잭션. 동시 저장이 DB 겹침 금지에 걸리면 서버가 먼저 찾은 것과 같은 409 다 */
  private async save<T>(
    work: (tx: Tx) => Promise<T>,
    options?: { timeout: number },
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work, options);
    } catch (error) {
      if (isOverlapViolation(error)) throw overlap();
      throw error;
    }
  }

  /**
   * 그 근무일에 근무스케줄을 받을 수 있는 직원인가. 범위 밖 · 없는 직원은 404, 본사 계정에게 가려지는 가맹 직원 · 계약
   * 기간 밖 · 퇴직일 뒤 · 가입 전은 400 이다. 저장할 때는 직원 행을 FOR NO KEY UPDATE 로 잠그고 읽는다 — 퇴직 확정(행 FOR UPDATE)과 겹치지 않고, 같은 직원의 저장끼리 한 줄로 선다(FOR SHARE 끼리면 둘 다 겹침 검사를 지나 서로를 기다리다 교착한다) — 퇴직
   * 정리가 지나간 뒤 퇴직일 다음 날 근무스케줄이 새로 생기지 않는다.
   */
  private async staffFor(
    db: Tx | PrismaService,
    scope: Scope,
    staffMemberId: number,
    workDate: Date,
    lock = false,
  ): Promise<{ storeId: number; contractId: number }> {
    if (lock)
      await db.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR NO KEY UPDATE`;
    const staff = await db.staffMember.findUnique({
      where: { staffMemberId },
      select: {
        storeId: true,
        retiredDate: true,
        joinStatus: true,
        ...HQ_SHARING_SELECT,
        contracts: {
          where: contractCovers(workDate),
          select: { contractId: true },
          orderBy: [{ startDate: 'desc' }, { contractId: 'desc' }],
          take: 1,
        },
      },
    });
    if (!staff || !scope.storeIds.includes(staff.storeId))
      throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
    if (scope.hide(staff.storeId, hqSharingConsentedOf(staff)))
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'WORK_SCHEDULE_HIDDEN',
        message:
          '본사 제공에 동의하지 않은 가맹 직원의 근무스케줄은 다룰 수 없습니다',
      });
    if (staff.joinStatus !== 'JOINED')
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'WORK_SCHEDULE_NOT_JOINED',
        message: '가입을 마친 직원만 근무스케줄을 받을 수 있습니다',
      });
    if (staff.retiredDate && staff.retiredDate < workDate)
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'WORK_SCHEDULE_AFTER_RETIREMENT',
        message: `퇴직일(${isoDate(staff.retiredDate)}) 뒤 날짜에는 근무스케줄을 넣을 수 없습니다`,
      });
    const contract = staff.contracts[0];
    if (!contract)
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'WORK_SCHEDULE_NO_CONTRACT',
        message: '근무일에 체결 완료된 근로계약이 없는 직원입니다',
      });
    return { storeId: staff.storeId, contractId: contract.contractId };
  }

  /**
   * 수정 · 삭제할 근무스케줄을 잠그고 읽는다. 잠금 순서는 퇴직 확정과 같은 직원 행(FOR NO KEY UPDATE) → 근무스케줄 행(FOR UPDATE)이다 — 반대로 잡으면
   * 퇴직 배치(직원 FOR UPDATE 뒤 근무스케줄 삭제)와 교착한다. 잠근 뒤 다시 읽으므로, 그사이 퇴직 정리 · 다른 삭제가
   * 지웠으면 404 이고, 이력의 변경 전 값은 실제 직전 값이다.
   */
  private async lockSchedule(
    tx: Tx,
    scope: Scope,
    workScheduleId: number,
  ): Promise<ScheduleRow> {
    const found = await this.scheduleFor(tx, scope, workScheduleId);
    await tx.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${found.staffMemberId} FOR NO KEY UPDATE`;
    const [now] = await tx.$queryRaw<
      { start_at: Date; end_at: Date; break_minutes: number }[]
    >`SELECT start_at, end_at, break_minutes FROM work_schedules WHERE work_schedule_id = ${workScheduleId} AND NOT is_deleted FOR UPDATE`;
    if (!now) throw new NotFoundException(SCHEDULE_NOT_FOUND);
    return {
      ...found,
      startAt: now.start_at,
      endAt: now.end_at,
      breakMinutes: now.break_minutes,
    };
  }

  /** 범위 안의 지우지 않은 근무스케줄. 없거나 지웠거나 범위 밖이면 404. 본사에게 가려지는 직원 것도 404 다 */
  private async scheduleFor(
    tx: Tx,
    scope: Scope,
    workScheduleId: number,
  ): Promise<ScheduleRow> {
    const row = await tx.workSchedule.findFirst({
      where: {
        workScheduleId,
        isDeleted: false,
        storeId: { in: scope.storeIds },
      },
      select: {
        ...SCHEDULE_SELECT,
        staffMember: { select: HQ_SHARING_SELECT },
      },
    });
    if (!row) throw new NotFoundException(SCHEDULE_NOT_FOUND);
    const { staffMember, ...schedule } = row;
    if (scope.hide(row.storeId, hqSharingConsentedOf(staffMember)))
      throw new NotFoundException(SCHEDULE_NOT_FOUND);
    return schedule;
  }

  /** 같은 직원 레코드의 지우지 않은 근무스케줄과 겹치면 409. 끝과 시작이 맞닿는 것은 겹치지 않는다(tstzrange [) 와 같다) */
  private async checkOverlap(
    tx: Tx,
    staffMemberId: number,
    span: Span,
    exceptId?: number,
  ): Promise<void> {
    const hit = await tx.workSchedule.findFirst({
      where: {
        staffMemberId,
        isDeleted: false,
        startAt: { lt: span.endAt },
        endAt: { gt: span.startAt },
        ...(exceptId ? { workScheduleId: { not: exceptId } } : {}),
      },
      select: { workScheduleId: true },
    });
    if (hit) throw overlap();
  }

  /**
   * 관리하는 점포와 본사 제공 동의 가림. 사용 중인 관리자 계정이 아니면 403. 저장 트랜잭션 전에 읽어 넘긴다 — 트랜잭션
   * 안에서 this.prisma 로 읽으면 연결을 하나 더 잡고, 연결이 모자라면 트랜잭션이 자기 연결을 기다리다 시간이 다 된다.
   */
  private async scopeOf(adminAccountId: number): Promise<Scope> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const typeOf = new Map(
      manageable.stores.map((s) => [s.storeId, s.storeTypeCode]),
    );
    const hide = (storeId: number, isHqSharingConsented: boolean) =>
      hidesPersonalData(
        manageable.roleTypeCode,
        typeOf.get(storeId),
        isHqSharingConsented,
      );
    return {
      storeIds: [...typeOf.keys()],
      hide,
      storeHides: (storeId: number): boolean | null =>
        typeOf.has(storeId) ? hide(storeId, false) : null,
    };
  }
}

/** 받은 근무일 · 시각을 순간으로. 24시간짜리 · 휴게가 근무 길이 이상이면 400 */
function spanOf(dto: WorkScheduleFieldsDto): { date: Date; span: Span } {
  const date = toDate(dto.workDate);
  const span = toSpan(date, dto.startTime, dto.endTime);
  if (!span)
    throw new BadRequestException(
      '시작과 종료가 같습니다 — 근무는 24시간보다 짧아야 합니다',
    );
  if (!breakFits(span, dto.breakMinutes))
    throw new BadRequestException('휴게시간이 근무시간보다 깁니다');
  return { date, span };
}
