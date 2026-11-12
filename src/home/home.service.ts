import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, InvitationType, Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import { hqVisibleWhere } from '../admin-scope/hq-visible';
import {
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
  type HqSharingSource,
} from '../admin-scope/hq-sharing';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import {
  adminHasMenuAction,
  BP_NOT_FOUND_MESSAGE,
  reportMissingMenu,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { parseRouteId } from '../common/route-id';
import {
  needsRenewal,
  RENEWAL_CANDIDATE_SELECT,
  renewalCandidateWhere,
} from '../contracts/contract-expiry.service';
import { RENEWAL_NOTICE_DAYS } from '../contracts/contract-renewal';
import { groupStatus } from '../todos/todo-rules';
import {
  attendanceDayStatus,
  type DayPair,
} from '../attendance/attendance-day-status';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, kstDayStart, kstToday } from '../staff-members/kst-date';
import {
  HomeCardsDto,
  HomePendingItemDto,
  HomePendingResponseDto,
  HomePendingType,
  HomeStoreRowDto,
  HomeSummaryResponseDto,
} from './dto/home.response.dto';

/** 영역마다 조회 권한을 보는 메뉴(menus.url). 출퇴근 현황 url 은 마이그레이션 20261015110333 의 MN000025 */
const AREA_MENU = {
  staff: '/staff-members',
  contracts: '/contracts',
  attendance: '/attendance-records',
  workSchedules: '/work-schedules',
  inquiries: '/support-inquiries',
  todos: '/todos',
} as const;
type Area = keyof typeof AREA_MENU;

/** 미체결 계약 — 발송 대기 · 서명 대기 · 수정 요청 */
const UNSIGNED: ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
];

/** 소속 확인 거절로 세는 초대 유형 — 소속 추가 확인 · 복귀 확인 */
const CONFIRM_TYPES: InvitationType[] = [
  'AFFILIATION_CONFIRM',
  'RETURN_CONFIRM',
];

/**
 * 재직 직원(운영 정책 HOM-02 · CTR-29) — 퇴직 처리되지 않았고, 임시저장 말고 다른 근로계약이 있는 레코드. 퇴직 예정(퇴직일까지
 * 재직)은 넣는다. 직원 목록에는 이 조건이 없어(초안 레코드도 목록에 보인다) 여기 둔다. 가입 여부는 보지 않는다 — TO-DO 의
 * ACTIVE_STAFF(가입 완료 · 체결 완료)보다 넓다.
 */
const EMPLOYED_STAFF = {
  employmentStatus: 'EMPLOYED',
  contracts: { some: { status: { not: 'DRAFT' } } },
} as const satisfies Prisma.StaffMemberWhereInput;

/** 확인 필요 문의 — 최근 며칠 안에 답변완료된 것 */
const INQUIRY_RECENT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 한국 날짜로 며칠 지났는가 */
const daysSince = (at: Date, now: Date) =>
  Math.round((kstToday(now).getTime() - kstToday(at).getTime()) / DAY_MS);

/** TO-DO 행을 목록 한 줄(배정 그룹은 하나)로 묶는다 — TO-DO 목록과 같은 열쇠 */
const todoLineKey = (r: {
  todoId: number;
  assignmentGroupId: number | null;
}) =>
  r.assignmentGroupId === null ? `t${r.todoId}` : `g${r.assignmentGroupId}`;

type RejectionSource = {
  retiredDate: Date | null;
  /** 가장 늦게 보낸 초대 하나 */
  invitations: {
    invitationType: InvitationType;
    status: string;
    sentAt: Date;
    respondedAt: Date | null;
  }[];
  /** 가장 늦게 만든 근로계약 하나 */
  contracts: { createdAt: Date | null }[];
};

/**
 * 소속 확인 거절이 아직 열려 있으면 거절 시각, 아니면 null. 그 직원 레코드의 마지막 초대가 거절(소속 추가 확인 · 복귀 확인)이고
 * 그 뒤 새 진행이 없을 때다 — 재발송 · 재초대면 마지막 초대가 바뀌고, 새 근로계약(기존 근로계약 대체 포함)이면 그 레코드에 거절보다
 * 늦게 만든 계약이 생기고, 퇴직 처리면 퇴직일이 정해진다(2026-10-27 재영). 응답 시각이 없으면 발송 시각으로 본다.
 */
export function openRejectionAt(row: RejectionSource): Date | null {
  const last = row.invitations[0];
  if (
    !last ||
    last.status !== 'REJECTED' ||
    !CONFIRM_TYPES.includes(last.invitationType) ||
    row.retiredDate !== null
  )
    return null;
  const at = last.respondedAt ?? last.sentAt;
  const newest = row.contracts[0]?.createdAt;
  return newest && newest.getTime() > at.getTime() ? null : at;
}

/** 처리 대기 한 유형의 한 건. 가장 오래 기다린 것이 앞에 오게 넘긴다 */
type Entry = {
  name: string | null;
  storeId: number | null;
  since: Date | null;
};

const pendingItemOf = (
  type: HomePendingType,
  entries: Entry[],
  status: string[],
  now: Date,
): HomePendingItemDto | null => {
  const first = entries[0];
  if (!first) return null;
  return {
    type,
    dueInDays: null,
    count: entries.length,
    firstName: first.name,
    isFirstNameMasked: first.name === null,
    othersCount: entries.length - 1,
    waitingDays: first.since ? daysSince(first.since, now) : null,
    filter: {
      storeIds: [
        ...new Set(
          entries.flatMap((e) => (e.storeId === null ? [] : [e.storeId])),
        ),
      ].sort((a, b) => a - b),
      status,
    },
  };
};

/**
 * 관리자 웹 로그인 후 홈의 집계(WHALEERP-305 · 306 · 665) — 수치 카드 · 점포별 현황 표(summary)와 확인 필요(pending).
 * 둘을 나눠 한쪽이 실패해도 다른 쪽은 보인다. 저장하지 않고 부를 때마다 센다. 「확인 필요」는 홈 영역 이름이다 — 출퇴근 기록
 * 꼬리표(ATT-19)와 다른 뜻이다.
 *
 * - 업무 범위: 관리 범위(getManageableStores) 안에서 고른 점포(storeIds). 범위 밖 ID 는 조용히 빠진다.
 * - 권한: 홈은 메뉴가 아니다. 영역마다 그 메뉴의 조회 권한이 있을 때만 채우고, 없으면 그 영역은 null 이다 — 403 으로 홈 전체를
 *   막지 않는다(직원 상세 요약과 같은 생각). 점포별 확인 필요는 볼 수 있는 영역의 건수만 더한다.
 * - 플랫폼 계정(플랫폼 BP 의 PM · PA)은 탭 BP 헤더로 고객 BP 를 고르면 그 BP 의 전체 점포로 BP 마스터와 같게 세고(본사 제공
 *   동의 가림 없음, ATT-30 플랫폼 기준), 고르지 않으면 platform: true 인 빈 결과다(WHALEERP-667, HOM-07 v280).
 * - 폐점 점포는 모든 집계에서 뺀다. 카드 · 표(summary)는 운영 점포만 세고(운영 정책 HOM-06 · HOM-10 — 열을 더하면 카드와 같다),
 *   확인 필요(pending)는 미운영 점포 건까지 센다(HOM-07).
 * - 본사 역할의 가림(운영 정책 ATT-30 v216, 2026-10-27 재영): 가려지는 점포(직영이 아닌 점포)에서는 계약 집계(미체결 · 서명
 *   대기 · 수정 요청과 경과 일수) · 갱신 예정 · 소속 확인 거절 · 정직원/파트 나눔을 본사 제공 동의한 직원 것만 센다 — 근로계약
 *   목록과 같은 조건이다. 점포별 확인 필요도 같은 집계에서 나와 합계가 맞는다. 재직 직원 총수만 그대로 센다(점포별 숫자).
 *   TO-DO(오늘 TO-DO · 긴급)는 TO-DO 목록처럼 가리지 않고 줄로 센다(HOM-10 v278, 2026-11-11 재영).
 * - 쿼리 수는 점포 수와 상관없이 일정하다 — 점포 단위로 묶어 세고 읽은 뒤 나눈다. 차례로 읽는다(동시에 읽으면 e2e 의 PGlite
 *   소켓 서버에서 깨진다 — 고객지원 문의와 같다).
 */
@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  async summary(
    adminAccountId: number,
    storeIds?: number[],
    now: Date = new Date(),
    bpHeader?: string,
  ): Promise<HomeSummaryResponseDto> {
    const ctx = await this.contextOf(
      adminAccountId,
      storeIds,
      bpHeader,
      [
        'staff',
        'contracts',
        'attendance',
        'workSchedules',
        'inquiries',
        'todos',
      ],
      true,
    );
    if (!ctx)
      return {
        asOf: now,
        platform: true,
        cards: null,
        storeTable: { total: 0, items: [] },
      };
    const { ids, stores, notOperating, can, shown, hides } = ctx;
    const today = kstToday(now);

    const staffByStore = new Map<number, number>();
    let staff: HomeCardsDto['staff'] = null;
    if (can('staff')) {
      // 총수는 가림 없이 점포별로 센다. 고용 형태 나눔은 개인 단위라 가려지는 점포에서는 동의한 직원만(ATT-30)이고, 그래서
      // 정직원 + 파트타이머가 총수보다 작을 수 있다
      const totals = await this.prisma.staffMember.groupBy({
        by: ['storeId'],
        where: { storeId: { in: ids }, ...EMPLOYED_STAFF },
        _count: { _all: true },
      });
      const split = await this.prisma.staffMember.groupBy({
        by: ['employmentType'],
        where: { AND: [shown.staff, EMPLOYED_STAFF] },
        _count: { _all: true },
      });
      staff = { total: 0, fullTime: 0, partTime: 0 };
      for (const g of totals) {
        staff.total += g._count._all;
        staffByStore.set(g.storeId, g._count._all);
      }
      for (const g of split)
        if (g.employmentType === 'FULL_TIME') staff.fullTime += g._count._all;
        else staff.partTime += g._count._all;
    }

    // 점포별 확인 필요는 점포마다 더해 간다(운영 정책 HOM-03)
    const pending = new Map<number, number>();
    const addPending = (storeId: number, n = 1) =>
      pending.set(storeId, (pending.get(storeId) ?? 0) + n);

    const unsignedByStore = new Map<number, number>();
    let unsignedContractCount: number | null = null;
    if (can('contracts')) {
      const groups = await this.prisma.contract.groupBy({
        by: ['storeId', 'status'],
        where: { AND: [shown.contract, { status: { in: UNSIGNED } }] },
        _count: { _all: true },
      });
      unsignedContractCount = 0;
      for (const g of groups) {
        const n = g._count._all;
        unsignedContractCount += n;
        unsignedByStore.set(
          g.storeId,
          (unsignedByStore.get(g.storeId) ?? 0) + n,
        );
        if (g.status !== 'PENDING_SEND') addPending(g.storeId, n);
      }
      for (const r of await this.renewals(shown.contract, today))
        addPending(r.storeId);
    }
    if (can('staff'))
      for (const r of await this.openRejections(shown.staff))
        addPending(r.storeId);
    if (can('todos'))
      for (const t of await this.urgentTodoLines(ids)) addPending(t.storeId);

    let todayAttendance: HomeCardsDto['todayAttendance'] = null;
    const scheduledByStore = new Map<number, number>();
    const checkedInByStore = new Map<number, number>();
    const absentByStore = new Map<number, number>();
    const showsAttendance = can('attendance') && can('workSchedules');
    if (showsAttendance) {
      const day = {
        gte: kstDayStart(today),
        lt: kstDayStart(addDays(today, 1)),
      };
      // 근무일은 시작 일시의 한국 날짜다(근무스케줄 관리와 같다). 한 직원이 하루에 여럿이어도 한 명이고, 그날 가장 이른
      // 근무의 시작 시각을 남긴다(미출근 판정). 근무 예정 수는 근무스케줄 화면처럼 가림 없이 센다
      const scheduled = await this.prisma.workSchedule.findMany({
        where: {
          storeId: { in: ids },
          isDeleted: false,
          startAt: day,
          staffMember: EMPLOYED_STAFF,
        },
        distinct: ['staffMemberId'],
        orderBy: [{ staffMemberId: 'asc' }, { startAt: 'asc' }],
        select: {
          storeId: true,
          staffMemberId: true,
          startAt: true,
          staffMember: { select: HQ_SHARING_SELECT },
        },
      });
      // 오늘 찍은 출퇴근 기록. 출퇴근 기록은 동의 항목이라 본사 역할에게 가려지는 점포는 동의한 직원 것만(운영 정책 ATT-30 v217)
      const punches = await this.prisma.attendanceRecord.findMany({
        where: {
          AND: [
            { storeId: { in: ids }, recordedAt: day },
            { staffMember: shown.staff },
          ],
        },
        select: {
          attendanceRecordId: true,
          storeId: true,
          staffMemberId: true,
          kind: true,
          recordedAt: true,
          reviewReason: true,
          entryMethod: true,
          checkInAttendanceRecordId: true,
        },
      });
      // 오늘 출근 = 출근 기록이 있는 직원. 미출근은 출퇴근 현황과 같은 판정(attendanceDayStatus 의 ABSENT, 운영 정책 ATT-34)이다.
      // 그날의 짝은 출퇴근 현황처럼 만든다 — 오늘 출근 하나마다 한 짝, 출근 없는 퇴근도 한 짝. 어제 출근의 짝 퇴근(밤샘 근무)은
      // 어제 날에 붙으므로 오늘 짝이 아니다. 오늘은 퇴근을 기다리는 날이라(checkOutDue 는 오늘이면 false) 짝의 퇴근은 판정에
      // 쓰이지 않아 비워 둔다
      const checkedIn = new Map<number, number>();
      const pairsOf = new Map<number, DayPair[]>();
      const addPair = (staffMemberId: number, pair: DayPair) =>
        pairsOf.set(staffMemberId, [
          ...(pairsOf.get(staffMemberId) ?? []),
          pair,
        ]);
      for (const p of punches) {
        if (p.kind === 'CHECK_IN') {
          checkedIn.set(p.staffMemberId, p.storeId);
          addPair(p.staffMemberId, { checkIn: p, checkOut: null });
        } else if (p.checkInAttendanceRecordId === null)
          addPair(p.staffMemberId, { checkIn: null, checkOut: p });
      }
      for (const s of scheduled)
        scheduledByStore.set(
          s.storeId,
          (scheduledByStore.get(s.storeId) ?? 0) + 1,
        );
      for (const storeId of checkedIn.values())
        checkedInByStore.set(storeId, (checkedInByStore.get(storeId) ?? 0) + 1);
      // scheduled 는 직원마다 그날 첫 근무 하나라 시작 시각 하나로 넘긴다(판정은 가장 이른 시작만 본다)
      const absent = scheduled.filter(
        (s) =>
          !hides(s.storeId, s.staffMember) &&
          attendanceDayStatus(
            [s.startAt],
            pairsOf.get(s.staffMemberId) ?? [],
            false,
            now,
          ) === 'ABSENT',
      );
      for (const s of absent)
        absentByStore.set(s.storeId, (absentByStore.get(s.storeId) ?? 0) + 1);
      todayAttendance = {
        scheduled: scheduled.length,
        checkedIn: checkedIn.size,
        notCheckedIn: absent.length,
      };
    }

    // 오늘 TO-DO — 수행 날짜가 오늘인 것. 배정 그룹은 한 건이고 그룹의 행이 모두 완료여야 완료다(HOM-10)
    let todayTodo: HomeCardsDto['todayTodo'] = null;
    const todoByStore = new Map<number, { done: number; total: number }>();
    if (can('todos')) {
      const rows = await this.prisma.todo.findMany({
        where: { storeId: { in: ids }, isDeleted: false, dueDate: today },
        select: {
          todoId: true,
          assignmentGroupId: true,
          storeId: true,
          status: true,
        },
      });
      const lines = new Map<string, typeof rows>();
      for (const r of rows)
        lines.set(todoLineKey(r), [...(lines.get(todoLineKey(r)) ?? []), r]);
      todayTodo = { done: 0, total: 0 };
      for (const line of lines.values()) {
        const done = groupStatus(line.map((r) => r.status)) === 'DONE' ? 1 : 0;
        const s = todoByStore.get(line[0].storeId) ?? { done: 0, total: 0 };
        todoByStore.set(line[0].storeId, {
          done: s.done + done,
          total: s.total + 1,
        });
        todayTodo.done += done;
        todayTodo.total += 1;
      }
    }

    let myInquiries: HomeCardsDto['myInquiries'] = null;
    if (can('inquiries')) {
      const groups = await this.prisma.inquiry.groupBy({
        by: ['status'],
        where: { createdBy: adminAccountId },
        _count: { _all: true },
      });
      myInquiries = { waiting: 0, answered: 0 };
      for (const g of groups)
        if (g.status === 'ANSWERED') myInquiries.answered += g._count._all;
        else myInquiries.waiting += g._count._all;
    }

    const rows: HomeStoreRowDto[] = stores.map((s) => ({
      storeId: s.storeId,
      storeName: s.name,
      storeTypeCode: s.storeTypeCode,
      staffCount: staff ? (staffByStore.get(s.storeId) ?? 0) : null,
      unsignedContractCount:
        unsignedContractCount === null
          ? null
          : (unsignedByStore.get(s.storeId) ?? 0),
      checkedInCount: showsAttendance
        ? (checkedInByStore.get(s.storeId) ?? 0)
        : null,
      scheduledCount: showsAttendance
        ? (scheduledByStore.get(s.storeId) ?? 0)
        : null,
      notCheckedInCount: showsAttendance
        ? (absentByStore.get(s.storeId) ?? 0)
        : null,
      todayTodo: todayTodo
        ? (todoByStore.get(s.storeId) ?? { done: 0, total: 0 })
        : null,
      pendingActionCount: pending.get(s.storeId) ?? 0,
    }));
    rows.sort(
      (a, b) =>
        b.pendingActionCount - a.pendingActionCount ||
        a.storeName.localeCompare(b.storeName, 'ko') ||
        a.storeId - b.storeId,
    );
    const direct = stores.filter((s) => s.storeTypeCode === 'DIRECT').length;
    return {
      asOf: now,
      platform: false,
      cards: {
        staff,
        unsignedContractCount,
        stores: {
          total: stores.length,
          direct,
          franchise: stores.length - direct,
          notOperating,
        },
        todayAttendance,
        myInquiries,
        todayTodo,
      },
      storeTable: { total: rows.length, items: rows },
    };
  }

  async pending(
    adminAccountId: number,
    storeIds?: number[],
    now: Date = new Date(),
    bpHeader?: string,
  ): Promise<HomePendingResponseDto> {
    const ctx = await this.contextOf(adminAccountId, storeIds, bpHeader, [
      'staff',
      'contracts',
      'inquiries',
      'todos',
    ]);
    if (!ctx) return { asOf: now, platform: true, items: [] };
    const { ids, can, shown, nameOf } = ctx;
    const today = kstToday(now);
    const items: (HomePendingItemDto | null)[] = [];

    if (can('contracts')) {
      // 종료가 가장 이른 계약이 대표다 — 그 계약의 종료까지 남은 날을 D-N 으로 보인다(HOM-04)
      const renewals = await this.renewals(shown.contract, today);
      const renewal = pendingItemOf(
        'CONTRACT_RENEWAL',
        renewals.map((c) => ({
          name: nameOf(c.storeId, c.staffMember),
          storeId: c.storeId,
          since: null,
        })),
        ['SIGNED'],
        now,
      );
      if (renewal)
        renewal.dueInDays = Math.round(
          (renewals[0].endDate!.getTime() - today.getTime()) / DAY_MS,
        );
      items.push(renewal);

      const waiting = await this.prisma.contract.findMany({
        where: {
          AND: [
            shown.contract,
            { status: { in: ['PENDING_SIGNATURE', 'CORRECTION_REQUESTED'] } },
          ],
        },
        select: {
          storeId: true,
          status: true,
          sentAt: true,
          staffMember: { select: { name: true, ...HQ_SHARING_SELECT } },
          // 수정 요청은 요청한 때부터 기다린다 — 가장 늦은 수정 요청 이력
          contractStatusHistories: {
            where: { toStatus: 'CORRECTION_REQUESTED' },
            orderBy: [
              { changedAt: 'desc' },
              { contractStatusHistoryId: 'desc' },
            ],
            take: 1,
            select: { changedAt: true },
          },
        },
      });
      for (const status of [
        'PENDING_SIGNATURE',
        'CORRECTION_REQUESTED',
      ] as const) {
        const entries = waiting
          .filter((c) => c.status === status)
          .map((c) => ({
            name: nameOf(c.storeId, c.staffMember),
            storeId: c.storeId,
            since:
              status === 'PENDING_SIGNATURE'
                ? c.sentAt
                : (c.contractStatusHistories[0]?.changedAt ?? null),
          }));
        items.push(
          pendingItemOf(
            status === 'PENDING_SIGNATURE'
              ? 'CONTRACT_PENDING_SIGNATURE'
              : 'CONTRACT_CORRECTION_REQUESTED',
            oldestFirst(entries),
            [status],
            now,
          ),
        );
      }
    }

    if (can('staff')) {
      const entries = (await this.openRejections(shown.staff)).map((r) => ({
        name: nameOf(r.storeId, r),
        storeId: r.storeId,
        since: r.rejectedAt,
      }));
      items.push(
        pendingItemOf(
          'AFFILIATION_REJECTED',
          oldestFirst(entries),
          ['REJECTED'],
          now,
        ),
      );
    }

    if (can('inquiries')) {
      // 마지막 답변이 최근 7일 안인 것(운영 정책 HOM-07, 2026-10-27 재영) — 답변을 고치면 다시 올라온다
      const since = kstDayStart(addDays(today, -INQUIRY_RECENT_DAYS));
      const replied = (
        await this.prisma.inquiryReply.groupBy({
          by: ['inquiryId'],
          where: { inquiry: { createdBy: adminAccountId, status: 'ANSWERED' } },
          _max: { repliedAt: true },
        })
      ).filter((r) => r._max.repliedAt && r._max.repliedAt >= since);
      const titles = replied.length
        ? new Map(
            (
              await this.prisma.inquiry.findMany({
                where: { inquiryId: { in: replied.map((r) => r.inquiryId) } },
                select: { inquiryId: true, title: true },
              })
            ).map((i) => [i.inquiryId, i.title]),
          )
        : new Map<number, string>();
      items.push(
        pendingItemOf(
          'INQUIRY_ANSWERED',
          oldestFirst(
            replied.map((r) => ({
              name: titles.get(r.inquiryId) ?? '',
              storeId: null,
              since: r._max.repliedAt,
            })),
          ),
          ['ANSWERED'],
          now,
        ),
      );
    }

    if (can('todos'))
      items.push(
        pendingItemOf(
          'URGENT_TODO',
          (await this.urgentTodoLines(ids)).map((t) => ({
            name: t.title,
            storeId: t.storeId,
            since: t.createdAt,
          })),
          ['PENDING', 'IN_PROGRESS'],
          now,
        ),
      );

    return {
      asOf: now,
      platform: false,
      items: items.filter((i): i is HomePendingItemDto => i !== null),
    };
  }

  /**
   * 계약 갱신 예정 — 종료일이 오늘부터 30일(RENEWAL_NOTICE_DAYS) 안이고 새 계약이 없는 것(HOM-03 · HOM-04). 대상 규칙은 하루
   * 배치와 같다(renewalCandidateWhere · needsRenewal). 종료가 이른 것이 앞이다.
   */
  private async renewals(
    shownContract: Prisma.ContractWhereInput,
    today: Date,
  ) {
    const candidates = await this.prisma.contract.findMany({
      where: {
        AND: [
          renewalCandidateWhere(today, addDays(today, RENEWAL_NOTICE_DAYS)),
          shownContract,
        ],
      },
      select: {
        ...RENEWAL_CANDIDATE_SELECT,
        storeId: true,
        staffMember: {
          select: {
            ...RENEWAL_CANDIDATE_SELECT.staffMember.select,
            name: true,
            ...HQ_SHARING_SELECT,
          },
        },
      },
      orderBy: [{ endDate: 'asc' }, { contractId: 'asc' }],
    });
    return candidates.filter(needsRenewal);
  }

  /**
   * 업무 범위와 영역 권한. 사용 중인 관리자 계정이 아니면 403(TO-DO 목록과 같다).
   * 플랫폼 계정은 탭 BP 헤더(`X-Bp-Code-Id`)로 고른 고객 BP 의 전체 점포가 관리 범위다(WHALEERP-667, 운영 정책 HOM-07 v280).
   * 홈은 메뉴가 아니라 가드가 탭 BP 를 정하지 않으므로 가드(targetBp)와 같은 기준으로 여기서 본다 — 지우지 않은 고객 BP 가
   * 아니면 404. 헤더가 없으면(BP 를 고르지 않은 플랫폼 탭) null 이다. BP · 가맹 계정은 헤더를 보지 않고 늘 소속 BP 다.
   * 고른 점포는 관리 범위
   * 안에서만 남고, 폐점 점포는 여기서 빠진다. `operatingOnly` 면 미운영 점포도 빠지고 그 수를 `notOperating` 으로 준다 — 그 영역의
   * 모든 집계가 같은 ids 를 쓴다. `shown` 은 개인 단위로 세는 집계에 거는 조건이다 — 가려지는 점포는 본사 제공 동의한 직원
   * 것만(hqVisibleWhere — 근로계약 목록과 같은 함수).
   */
  private async contextOf(
    adminAccountId: number,
    storeIds: number[] | undefined,
    bpHeader: string | undefined,
    areas: Area[],
    operatingOnly = false,
  ) {
    const access = await this.scope.platformAdminAccess(adminAccountId);
    if (access === 'unavailable')
      throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    let bp: TargetBpContext | undefined;
    if (access === 'allowed') {
      if (bpHeader === undefined) return null;
      const bpCodeId = parseRouteId(bpHeader);
      const found =
        bpCodeId === null
          ? null
          : await this.prisma.bpCode.findFirst({
              where: { bpCodeId, isDeleted: false, isPlatform: false },
              select: { bpCodeId: true },
            });
      if (!found) throw new NotFoundException(BP_NOT_FOUND_MESSAGE);
      bp = { bpCodeId: found.bpCodeId, isPlatformCaller: true };
    }
    const manageable = await this.scope.getManageableStores(adminAccountId, bp);
    if (!manageable) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const picked = storeIds ? new Set(storeIds) : null;
    const storeOf = new Map(
      manageable.stores
        .filter((s) => !picked || picked.has(s.storeId))
        .map((s) => [s.storeId, s]),
    );
    const live = await this.prisma.store.findMany({
      where: {
        storeId: { in: [...storeOf.keys()] },
        storeStatusCode: { not: 'CLOSED' },
      },
      select: {
        storeId: true,
        name: true,
        storeTypeCode: true,
        storeStatusCode: true,
      },
    });
    const stores = operatingOnly
      ? live.filter((s) => s.storeStatusCode === 'OPERATING')
      : live;
    const ids = stores.map((s) => s.storeId);
    const shown = hqVisibleWhere(manageable.roleTypeCode, ids, storeOf);
    /** 이 직원의 개인 단위 자료를 가리는가 — shown 과 같은 판정을 읽은 행에 한다 */
    const hides = (storeId: number, staff: HqSharingSource) =>
      hidesPersonalData(
        manageable.roleTypeCode,
        storeOf.get(storeId),
        hqSharingConsentedOf(staff),
      );
    const readable = new Set<Area>();
    for (const area of areas)
      if (await this.canRead(adminAccountId, AREA_MENU[area]))
        readable.add(area);
    return {
      ids,
      stores,
      notOperating: live.length - stores.length,
      shown,
      can: (area: Area) => readable.has(area),
      hides,
      /** 확인 필요의 직원 이름 — 가려지면 null(hidesPersonalData). shown 이 동의한 직원만 남겨 지금은 늘 이름이지만, 두 판정이 어긋나도 이름이 새지 않게 둔다 */
      nameOf: (storeId: number, staff: { name: string } & HqSharingSource) =>
        hides(storeId, staff) ? null : staff.name,
    };
  }

  /** 그 메뉴의 조회 권한(가드와 같은 판정). 없으면 판정할 메뉴가 아예 없는지 로그를 남긴다(requireAreaRead 와 같다) */
  private async canRead(adminAccountId: number, url: string) {
    const menu = { url };
    if (await adminHasMenuAction(this.prisma, adminAccountId, menu, ['read']))
      return true;
    await reportMissingMenu(this.prisma, this.logger, menu, HomeService.name);
    return false;
  }

  /** 열려 있는 소속 확인 거절(openRejectionAt). 거절이 있었던 재직 레코드만 읽고 마지막 초대 · 계약 하나씩을 함께 읽는다 */
  private async openRejections(shownStaff: Prisma.StaffMemberWhereInput) {
    const rows = await this.prisma.staffMember.findMany({
      where: {
        AND: [
          shownStaff,
          {
            employmentStatus: 'EMPLOYED',
            invitations: {
              some: {
                status: 'REJECTED',
                invitationType: { in: CONFIRM_TYPES },
              },
            },
          },
        ],
      },
      select: {
        storeId: true,
        name: true,
        retiredDate: true,
        ...HQ_SHARING_SELECT,
        // 「마지막 초대」는 직원 목록(displayInvitation)처럼 가장 늦게 보낸 것, 같으면 id 가 큰 것
        invitations: {
          orderBy: [{ sentAt: 'desc' }, { invitationId: 'desc' }],
          take: 1,
          select: {
            invitationType: true,
            status: true,
            sentAt: true,
            respondedAt: true,
          },
        },
        // created_at 은 nullable 이다. DESC 의 기본은 NULL 먼저라 nulls last
        contracts: {
          orderBy: [
            { createdAt: { sort: 'desc', nulls: 'last' } },
            { contractId: 'desc' },
          ],
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    return rows.flatMap((r) => {
      const rejectedAt = openRejectionAt(r);
      return rejectedAt ? [{ ...r, rejectedAt }] : [];
    });
  }

  /**
   * 긴급 TO-DO 미완료 — TO-DO 목록처럼 배정 그룹은 한 줄로 센다. 그룹에 미완료 행이 하나라도 있으면 미완료다(groupStatus).
   * 등록이 이른 것이 앞이다.
   */
  private async urgentTodoLines(ids: number[]) {
    const rows = await this.prisma.todo.findMany({
      where: {
        storeId: { in: ids },
        isDeleted: false,
        isUrgent: true,
        status: { not: 'DONE' },
      },
      select: {
        todoId: true,
        assignmentGroupId: true,
        storeId: true,
        title: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { todoId: 'asc' }],
    });
    const lines = new Map<string, (typeof rows)[number]>();
    for (const r of rows)
      if (!lines.has(todoLineKey(r))) lines.set(todoLineKey(r), r);
    return [...lines.values()];
  }
}

/** 가장 오래 기다린 것이 앞 — 시각이 없으면 뒤 */
function oldestFirst<T extends Entry>(entries: T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity),
  );
}
