import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { adminNames } from '../common/admin-names';
import { containsText } from '../common/contains-text';
import { dateOnly } from '../common/date-only';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, kstDayStart, parseDateOnly } from '../staff-members/kst-date';
import { actionsOf, inScope, type HolidayCaller } from './bp-holiday-access';
import { ruleOf } from './bp-holiday-rule';
import {
  HOLIDAY_SELECT,
  managedOf,
  visibleWhere,
  type HolidayRow,
} from './bp-holiday-rows';
import type {
  BpHolidayDateRowResponseDto,
  BpHolidayDetailResponseDto,
  BpHolidayStoreResponseDto,
  BpHolidayHistoryListResponseDto,
  BpHolidayHistoryResponseDto,
  BpHolidayListResponseDto,
  BpHolidayOverlapsResponseDto,
} from './dto/bp-holiday.response.dto';
import type {
  ListBpHolidayHistoriesQueryDto,
  ListBpHolidaysQueryDto,
} from './dto/list-bp-holidays-query.dto';
import type { CheckBpHolidayOverlapsDto } from './dto/save-bp-holiday.dto';
import {
  appliedStoresOn,
  STORE_SELECT,
  storeOpenOn,
  type HolidayStore,
  type StorePeriodRow,
} from './holiday-application';
import {
  datesBetween,
  holidayStateOf,
  lastDateOf,
  nextDatesAfter,
} from './holiday-dates';
import { appliesOn, periodStateOf } from './store-periods';

export const NOT_FOUND = 'BP 휴일을 찾을 수 없습니다';
/** 겹침을 보는 기간 — 끝이 없거나 긴 반복도 오늘(시작 전이면 시작일)부터 1년 안에서만 센다. */
const OVERLAP_WINDOW_DAYS = 365;
/** 점포마다 보여 줄 겹치는 날짜 수(나머지는 건수로, WHALEERP-556). */
const OVERLAP_DATES_SHOWN = 10;

const HISTORY_SELECT = {
  changeId: true,
  bpHolidayId: true,
  field: true,
  beforeValue: true,
  afterValue: true,
  changedAt: true,
  changedBy: true,
  bpHoliday: { select: { name: true } },
} as const;
const HISTORY_ORDER = [
  { changedAt: 'desc' as const },
  { changeId: 'desc' as const },
];

/**
 * BP 휴일 관리(MN000015)의 조회 — 월 캘린더 · 목록, 상세, 변경 이력, 겹치는 휴일 확인. 날짜는 저장한 규칙으로
 * 볼 때 계산한다(CONFIG-8). 「오늘」은 컨트롤러가 kstToday 로 정해 넘긴다.
 */
@Injectable()
export class BpHolidaysService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    caller: HolidayCaller,
    query: ListBpHolidaysQueryDto,
    today: Date,
  ): Promise<BpHolidayListResponseDto> {
    const from = new Date(Date.UTC(query.year, query.month - 1, 1));
    const to = addDays(new Date(Date.UTC(query.year, query.month, 1)), -1);
    const [holidays, bp, publicHolidays] = await Promise.all([
      this.prisma.bpHoliday.findMany({
        where: {
          ...visibleWhere(caller),
          isDeleted: false,
          ...(query.name && { name: containsText(query.name) }),
          startDate: { lte: to },
          // 범위 조건(visibleWhere)이 OR 를 쓰므로 날짜 조건은 AND 안에 둔다.
          AND: [{ OR: [{ endDate: null }, { endDate: { gte: from } }] }],
        },
        select: HOLIDAY_SELECT,
        orderBy: { bpHolidayId: 'asc' },
      }),
      this.prisma.bpCode.findUniqueOrThrow({
        where: { bpCodeId: caller.bpCodeId },
        select: { tradeName: true },
      }),
      this.prisma.publicHoliday.findMany({
        where: { holidayDate: { gte: from, lte: to } },
        select: { holidayDate: true, name: true },
        orderBy: { holidayDate: 'asc' },
      }),
    ]);
    const names = await adminNames(
      this.prisma,
      holidays.map((h) => h.updatedBy),
    );
    const items: BpHolidayDateRowResponseDto[] = [];
    for (const h of holidays) {
      const actions = actionsOf(caller, managedOf(h), today);
      for (const date of datesBetween(h, from, to)) {
        const target = this.targetOn(h, date, caller, bp.tradeName);
        if (!target) continue;
        items.push({
          date: dateOnly(date),
          bpHolidayId: h.bpHolidayId,
          name: h.name,
          holidayTypeCode: h.holidayTypeCode,
          holidayRepeatTypeCode: h.holidayRepeatTypeCode,
          target,
          isPast: date < today,
          updatedAt: h.updatedAt.toISOString(),
          updatedByName: names.get(h.updatedBy) ?? null,
          actions,
        });
      }
    }
    items.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Number(b.target.isAllStores) - Number(a.target.isAllStores) ||
        a.bpHolidayId - b.bpHolidayId,
    );
    return {
      year: query.year,
      month: query.month,
      items,
      total: items.length,
      publicHolidays: publicHolidays.map((p) => ({
        holidayDate: dateOnly(p.holidayDate),
        name: p.name,
      })),
    };
  }

  async detail(
    caller: HolidayCaller,
    bpHolidayId: number,
    rawDate: string | undefined,
    today: Date,
  ): Promise<BpHolidayDetailResponseDto> {
    const h = await this.prisma.bpHoliday.findFirst({
      where: { ...visibleWhere(caller), bpHolidayId, isDeleted: false },
      select: {
        ...HOLIDAY_SELECT,
        changeHistories: { select: HISTORY_SELECT, orderBy: HISTORY_ORDER },
      },
    });
    if (!h) throw new NotFoundException(NOT_FOUND);
    const ref = (rawDate && parseDateOnly(rawDate)) || today;
    const bpStores = h.isAllStores ? await this.bpStores(caller.bpCodeId) : [];
    const names = await adminNames(this.prisma, [
      h.createdBy,
      h.updatedBy,
      ...h.changeHistories.map((c) => c.changedBy),
    ]);
    return {
      bpHolidayId: h.bpHolidayId,
      name: h.name,
      description: h.description,
      isAllStores: h.isAllStores,
      holidayTypeCode: h.holidayTypeCode,
      startDate: dateOnly(h.startDate),
      endDate: dateOnly(h.endDate),
      holidayRepeatTypeCode: h.holidayRepeatTypeCode,
      repeatEndType: h.repeatEndType,
      repeatEndDate: dateOnly(h.repeatEndDate),
      repeatCount: h.repeatCount,
      state: holidayStateOf(h, today),
      stores: this.storePeriodsOf(h, caller, today),
      appliedStoreCount: appliedStoresOn(h, bpStores, ref).length,
      nextDates:
        h.holidayTypeCode === 'REPEAT'
          ? nextDatesAfter(h, ref, 3).map((x) => dateOnly(x))
          : [],
      histories: h.changeHistories.map((c) => historyOf(c, names)),
      actions: actionsOf(caller, managedOf(h), today),
      createdAt: h.createdAt.toISOString(),
      createdByName: names.get(h.createdBy) ?? null,
      updatedAt: h.updatedAt.toISOString(),
      updatedByName: names.get(h.updatedBy) ?? null,
    };
  }

  /** 기간에 생긴 변경 이력 — 지운 휴일의 이력도 준다(지운 휴일은 여기서만 보인다, WHALEERP-555). 최근 것부터. */
  async histories(
    caller: HolidayCaller,
    query: ListBpHolidayHistoriesQueryDto,
    today: Date,
  ): Promise<BpHolidayHistoryListResponseDto> {
    // 한쪽만 보내면 다른 쪽 기본값을 그에 맞춘다 — 끝만 보내면 시작은 그 달 1일, 시작만 보내면 끝은 오늘(시작이
    // 오늘 뒤면 그 날). 보내지 않은 기본값 때문에 400 이 나지 않게 한다. 둘 다 보내 거꾸로면 400 이다.
    const sentFrom = query.from ? parseDateOnly(query.from) : null;
    const sentTo = query.to ? parseDateOnly(query.to) : null;
    const to = sentTo ?? (sentFrom && sentFrom > today ? sentFrom : today);
    const from =
      sentFrom ?? new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    if (from > to)
      throw new BadRequestException('시작 날짜는 끝 날짜보다 늦을 수 없습니다');
    const where = {
      changedAt: { gte: kstDayStart(from), lt: kstDayStart(addDays(to, 1)) },
      bpHoliday: visibleWhere(caller),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bpHolidayChangeHistory.findMany({
        where,
        select: HISTORY_SELECT,
        orderBy: HISTORY_ORDER,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.bpHolidayChangeHistory.count({ where }),
    ]);
    const names = await adminNames(
      this.prisma,
      rows.map((r) => r.changedBy),
    );
    return { items: rows.map((r) => historyOf(r, names)), total };
  }

  /**
   * 겹치는 휴일 확인(WHALEERP-556) — 저장은 막지 않고, 같은 점포 · 같은 날짜에 이미 있는 휴일을 점포별로 준다.
   * 새 휴일의 날짜는 오늘(시작 전이면 시작일)부터 1년 안에서만 본다. 공식 휴일과 겹치는지는 보지 않는다.
   */
  async overlaps(
    caller: HolidayCaller,
    dto: CheckBpHolidayOverlapsDto,
    today: Date,
  ): Promise<BpHolidayOverlapsResponseDto> {
    // 수정 중인 휴일은 볼 수 있는 휴일이어야 하고, 진행 중이면 시작일이 지났다 — 그때만 지난 시작일을 받는다.
    let editingStarted = false;
    if (dto.bpHolidayId) {
      const editing = await this.prisma.bpHoliday.findFirst({
        where: {
          ...visibleWhere(caller),
          bpHolidayId: dto.bpHolidayId,
          isDeleted: false,
        },
        select: { startDate: true },
      });
      if (!editing) throw new NotFoundException(NOT_FOUND);
      editingStarted = editing.startDate <= today;
    }
    const rule = ruleOf(dto, today, { allowPastStart: editingStarted });
    const from = rule.startDate > today ? rule.startDate : today;
    const windowEnd = addDays(from, OVERLAP_WINDOW_DAYS);
    const last = lastDateOf(rule);
    const to = last && last < windowEnd ? last : windowEnd;
    const newDates = datesBetween(rule, from, to);
    if (!newDates.length) return { storeCount: 0, dateCount: 0, stores: [] };

    const [bpStores, others] = await Promise.all([
      this.bpStores(caller.bpCodeId),
      this.prisma.bpHoliday.findMany({
        where: {
          bpCodeId: caller.bpCodeId,
          isDeleted: false,
          ...(dto.bpHolidayId && { bpHolidayId: { not: dto.bpHolidayId } }),
          startDate: { lte: to },
          OR: [{ endDate: null }, { endDate: { gte: from } }],
        },
        select: HOLIDAY_SELECT,
        orderBy: { bpHolidayId: 'asc' },
      }),
    ]);
    const excluded = new Set(dto.excludedStoreIds ?? []);
    const wanted = new Set(dto.storeIds ?? []);
    // 맡지 않은 점포의 이름 · 다른 휴일은 주지 않는다 — 일부 점포 사용자는 맡은 점포의 겹침만 본다.
    const targets = bpStores.filter(
      (s) =>
        inScope(caller, s.storeId) &&
        (dto.isAllStores ? !excluded.has(s.storeId) : wanted.has(s.storeId)),
    );
    // 기존 휴일마다 기간 안 날짜를 한 번만 계산한다.
    const otherDates = others.map((h) => ({
      h,
      dates: new Set(datesBetween(h, from, to).map((x) => x.getTime())),
    }));
    const stores: BpHolidayOverlapsResponseDto['stores'] = [];
    let dateCount = 0;
    for (const s of targets) {
      const dates: { date: string; holidayNames: string[] }[] = [];
      for (const date of newDates) {
        if (!storeOpenOn(s, date, dto.isAllStores)) continue;
        const holidayNames = otherDates
          .filter(
            ({ h, dates: ds }) =>
              ds.has(date.getTime()) &&
              appliedStoresOn(h, bpStores, date).some(
                (a) => a.storeId === s.storeId,
              ),
          )
          .map(({ h }) => h.name);
        if (holidayNames.length)
          dates.push({ date: dateOnly(date), holidayNames });
      }
      if (!dates.length) continue;
      dateCount += dates.length;
      stores.push({
        storeId: s.storeId,
        storeName: s.name,
        dates: dates.slice(0, OVERLAP_DATES_SHOWN),
        moreDateCount: Math.max(0, dates.length - OVERLAP_DATES_SHOWN),
      });
    }
    return { storeCount: stores.length, dateCount, stores };
  }

  /**
   * 목록의 「적용 대상」. 특정 점포 휴일은 그날 적용되는 점포 중 맡은 점포가 없으면 null(그 줄을 주지 않는다).
   * 전체 점포 휴일은 언제나 보인다.
   */
  private targetOn(
    h: HolidayRow,
    date: Date,
    caller: HolidayCaller,
    bpTradeName: string | null,
  ): BpHolidayDateRowResponseDto['target'] | null {
    if (h.isAllStores)
      return {
        isAllStores: true,
        bpTradeName,
        firstStoreName: null,
        otherStoreCount: 0,
        excludedStoreCount: h.excludedStores.filter((p) => appliesOn(p, date))
          .length,
      };
    const applied = appliedStoresOn(h, [], date);
    if (!applied.some((s) => inScope(caller, s.storeId))) return null;
    return {
      isAllStores: false,
      bpTradeName: null,
      firstStoreName: applied[0].name,
      otherStoreCount: applied.length - 1,
      excludedStoreCount: 0,
    };
  }

  /**
   * 상세의 대상 점포(특정 점포 휴일) · 예외 점포(전체 점포 휴일) — 지우지 않은 모든 기간, 기간마다 한 줄. 같은 점포를
   * 뺐다 다시 더했으면 두 줄이다. 점포명 → 점포 ID → 적용 시작일 → 기간 ID 순이라 같은 점포의 「적용 → 빠짐 →
   * 다시 적용」이 붙어 나온다(이름은 고유하지 않다). 상태는 오늘 기준이라 `?date` 를 따르지 않고, 휴일 자체의
   * 끝(강제 종료 포함)까지 반영한다(front 요청, 2026-10-26).
   */
  private storePeriodsOf(
    h: HolidayRow,
    caller: HolidayCaller,
    today: Date,
  ): BpHolidayStoreResponseDto[] {
    const holidayLast = lastDateOf(h);
    const periods: (StorePeriodRow & { periodId: number })[] = h.isAllStores
      ? h.excludedStores.map((p) => ({
          ...p,
          periodId: p.holidayExcludedStoreId,
        }))
      : h.storeMappings.map((p) => ({
          ...p,
          periodId: p.holidayStoreMappingId,
        }));
    return periods
      .sort(
        (a, b) =>
          a.store.name.localeCompare(b.store.name) ||
          a.storeId - b.storeId ||
          a.effectiveStartDate.getTime() - b.effectiveStartDate.getTime() ||
          a.periodId - b.periodId,
      )
      .map((p) => ({
        periodId: p.periodId,
        storeId: p.storeId,
        storeCode: p.store.storeCode,
        name: p.store.name,
        storeTypeCode: p.store.storeTypeCode,
        storeStatusCode: p.store.storeStatusCode,
        effectiveStartDate: dateOnly(p.effectiveStartDate),
        effectiveEndDate: dateOnly(p.effectiveEndDate),
        periodState: periodStateOf(p, holidayLast, today),
        isManaged: inScope(caller, p.storeId),
      }));
  }

  /** 그 BP 의 지우지 않은 점포, 이름순 — 전체 점포 휴일의 적용 점포를 계산한다. */
  private bpStores(bpCodeId: number): Promise<HolidayStore[]> {
    return this.prisma.store.findMany({
      where: { bpCodeId, isDeleted: false },
      select: STORE_SELECT,
      orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
    });
  }
}

function historyOf(
  row: {
    changeId: number;
    bpHolidayId: number;
    field: string;
    beforeValue: string | null;
    afterValue: string | null;
    changedAt: Date;
    changedBy: number | null;
    bpHoliday: { name: string };
  },
  names: Map<number | null, string | null>,
): BpHolidayHistoryResponseDto {
  return {
    changeId: row.changeId,
    bpHolidayId: row.bpHolidayId,
    holidayName: row.bpHoliday.name,
    field: row.field,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    changedAt: row.changedAt.toISOString(),
    changedByName: names.get(row.changedBy) ?? null,
  };
}
