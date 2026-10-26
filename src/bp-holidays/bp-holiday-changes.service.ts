import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dateOnly } from '../common/date-only';
import { isSameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import { addDays } from '../staff-members/kst-date';
import {
  ALL_STORES_REASON,
  ENDED_REASON,
  inScope,
  managesWhole,
  SHARED_REASON,
  type HolidayCaller,
} from './bp-holiday-access';
import { describeRule, ruleOf, sameRule } from './bp-holiday-rule';
import {
  HOLIDAY_SELECT,
  managedOf,
  openPeriodsOf,
  visibleWhere,
  type HolidayRow,
} from './bp-holiday-rows';
import { NOT_FOUND } from './bp-holidays.service';
import type {
  SaveBpHolidayDto,
  UpdateBpHolidayDto,
} from './dto/save-bp-holiday.dto';
import { holidayStateOf, type HolidayRule } from './holiday-dates';
import {
  planStorePeriods,
  type OpenPeriod,
  type PeriodPlan,
} from './store-periods';

type Tx = Prisma.TransactionClient;
type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

export const CONFLICT_MESSAGE =
  '다른 사용자가 먼저 수정했습니다. 다시 불러온 뒤 시도해 주세요';
const OUT_OF_SCOPE = '맡지 않은 점포는 다룰 수 없습니다';
const ONGOING_FIXED =
  '진행 중인 휴일은 휴일 유형 · 날짜 · 반복 · 적용 범위를 바꿀 수 없습니다 — 강제 종료하거나 새 휴일을 등록해 주세요';
const TERMINATE_NOT_STARTED =
  '어제 이전에 시작한 휴일만 강제 종료할 수 있습니다 — 오늘부터 시작하는 휴일은 삭제해 주세요';
const DELETE_STARTED =
  '이미 지난 날짜가 있는 휴일은 지울 수 없습니다 — 강제 종료해 주세요';

/** 두 표(대상 · 예외 점포)의 같은 모양 — 기간 행 ID 칸 이름만 다르다. */
const TABLES = {
  mappings: {
    label: '대상 점포',
    rows: (h: HolidayRow) =>
      h.storeMappings.map((p) => ({ ...p, id: p.holidayStoreMappingId })),
    model: (tx: Tx) => tx.holidayStoreMapping,
    idKey: 'holidayStoreMappingId',
  },
  excluded: {
    label: '예외 점포',
    rows: (h: HolidayRow) =>
      h.excludedStores.map((p) => ({ ...p, id: p.holidayExcludedStoreId })),
    model: (tx: Tx) => tx.holidayExcludedStore,
    idKey: 'holidayExcludedStoreId',
  },
} as const;
type TableKey = keyof typeof TABLES;

/**
 * BP 휴일 등록 · 수정 · 강제 종료 · 삭제(BP 휴일 변경 · 종료 정책, 2026-10-26 1팀). 지난 날짜의 휴일은 어떤 변경으로도
 * 바뀌지 않는다:
 * - 시작 전 휴일은 모두 고친다. 진행 중이면 휴일명 · 설명 · 점포만, 끝났으면 아무것도 못 고친다.
 * - 점포를 더하면 오늘(시작 전이면 휴일 시작일)부터, 빼면 어제까지다(store-periods).
 * - 강제 종료는 어제 날짜로 끝낸다 — 시작일이 어제 이전인 휴일만. 삭제는 시작일이 오늘 이후인 휴일만.
 * - 범위 밖 점포가 묶인 휴일은 일부 점포 사용자가 맡은 점포만 빼거나 더한다(bp-holiday-access).
 * 수정 · 강제 종료 · 삭제는 휴일 행을 FOR UPDATE 로 잠그고 다시 읽은 값으로 판정한다.
 */
@Injectable()
export class BpHolidayChangesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    caller: HolidayCaller,
    dto: SaveBpHolidayDto,
    today: Date,
  ): Promise<{ bpHolidayId: number }> {
    const rule = ruleOf(dto, today);
    if (dto.isAllStores && !caller.manageAll)
      throw new ForbiddenException(ALL_STORES_REASON);
    const storeIds = unique(
      dto.isAllStores ? dto.excludedStoreIds : dto.storeIds,
    );
    if (!dto.isAllStores && !storeIds.length)
      throw new BadRequestException('대상 점포를 하나 이상 골라 주세요');
    return this.prisma.$transaction(async (tx) => {
      const stores = await this.addableStores(tx, caller, storeIds);
      const rows = storeIds.map((storeId) => ({
        storeId,
        effectiveStartDate: rule.startDate,
        createdBy: caller.adminAccountId,
        updatedBy: caller.adminAccountId,
      }));
      const { bpHolidayId } = await tx.bpHoliday.create({
        data: {
          bpCodeId: caller.bpCodeId,
          isAllStores: dto.isAllStores,
          ...rule,
          name: dto.name,
          description: dto.description || null,
          createdBy: caller.adminAccountId,
          updatedBy: caller.adminAccountId,
          ...(dto.isAllStores
            ? { excludedStores: { createMany: { data: rows } } }
            : { storeMappings: { createMany: { data: rows } } }),
        },
        select: { bpHolidayId: true },
      });
      const target = dto.isAllStores
        ? `전체 점포${storeIds.length ? ` · 예외 ${storeIds.length}개점` : ''}`
        : storeIds.map((id) => stores.get(id)).join(' · ');
      await this.record(tx, caller, bpHolidayId, [
        {
          field: '등록',
          beforeValue: null,
          afterValue: `${dto.name} · ${target} · ${describeRule(rule)}`,
        },
      ]);
      return { bpHolidayId };
    });
  }

  async update(
    caller: HolidayCaller,
    bpHolidayId: number,
    dto: UpdateBpHolidayDto,
    today: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockAndRead(
        tx,
        caller,
        bpHolidayId,
        dto.updatedAt,
      );
      const state = holidayStateOf(row, today);
      if (state === 'ENDED') throw new ConflictException(ENDED_REASON);
      const upcoming = state === 'UPCOMING';
      const rule = ruleOf(dto, today, { allowPastStart: !upcoming });
      const ruleChanged = !sameRule(rule, row);
      const scopeChanged = dto.isAllStores !== row.isAllStores;
      if (!upcoming && (ruleChanged || scopeChanged))
        throw new ConflictException(ONGOING_FIXED);

      const description = dto.description || null;
      const histories: History[] = [];
      if (dto.name !== row.name)
        histories.push({
          field: '휴일명',
          beforeValue: row.name,
          afterValue: dto.name,
        });
      if (description !== row.description)
        histories.push({
          field: '설명',
          beforeValue: row.description,
          afterValue: description,
        });
      if (ruleChanged)
        histories.push({
          field: '날짜',
          beforeValue: describeRule(row),
          afterValue: describeRule(rule),
        });
      if (scopeChanged)
        histories.push({
          field: '적용 범위',
          beforeValue: scopeLabel(row.isAllStores),
          afterValue: scopeLabel(dto.isAllStores),
        });
      // 휴일 전체를 다루지 않는 사용자(범위 밖 점포가 묶인 휴일)는 점포 말고는 못 고친다.
      if (histories.length && !managesWhole(caller, managedOf(row)))
        throw new ForbiddenException(
          row.isAllStores ? ALL_STORES_REASON : SHARED_REASON,
        );
      if (scopeChanged && !caller.manageAll)
        throw new ForbiddenException(ALL_STORES_REASON);

      const storeHistories = await this.applyStores(
        tx,
        caller,
        row,
        dto,
        rule,
        today,
      );
      // 시작 전 휴일의 점포는 휴일 시작일부터다 — 시작일을 옮기면 열린 기간도 따라 옮긴다.
      if (upcoming && rule.startDate.getTime() !== row.startDate.getTime())
        for (const key of Object.keys(TABLES) as TableKey[])
          await (
            TABLES[key].model(tx) as typeof tx.holidayStoreMapping
          ).updateMany({
            where: { bpHolidayId, isDeleted: false, effectiveEndDate: null },
            data: {
              effectiveStartDate: rule.startDate,
              updatedBy: caller.adminAccountId,
            },
          });
      histories.push(...storeHistories);
      if (!histories.length) return;
      await tx.bpHoliday.update({
        where: { bpHolidayId },
        data: {
          name: dto.name,
          description,
          ...(upcoming && { ...rule, isAllStores: dto.isAllStores }),
          updatedBy: caller.adminAccountId,
        },
      });
      await this.record(tx, caller, bpHolidayId, histories);
    });
  }

  /** 강제 종료 — 어제(한국 날짜)로 끝낸다. 되돌리지 않는다. 대상 · 예외 점포 기간은 그대로 둔다. */
  async terminate(
    caller: HolidayCaller,
    bpHolidayId: number,
    updatedAt: string,
    today: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockAndRead(tx, caller, bpHolidayId, updatedAt);
      if (holidayStateOf(row, today) === 'ENDED')
        throw new ConflictException(ENDED_REASON);
      const yesterday = addDays(today, -1);
      if (row.startDate > yesterday)
        throw new ConflictException(TERMINATE_NOT_STARTED);
      this.assertWhole(caller, row);
      const ended: HolidayRule =
        row.holidayTypeCode === 'REPEAT'
          ? {
              ...row,
              repeatEndType: 'UNTIL_DATE',
              repeatEndDate: yesterday,
              repeatCount: null,
            }
          : { ...row, endDate: yesterday };
      await tx.bpHoliday.update({
        where: { bpHolidayId },
        data:
          row.holidayTypeCode === 'REPEAT'
            ? {
                repeatEndType: 'UNTIL_DATE',
                repeatEndDate: yesterday,
                repeatCount: null,
                updatedBy: caller.adminAccountId,
              }
            : { endDate: yesterday, updatedBy: caller.adminAccountId },
      });
      await this.record(tx, caller, bpHolidayId, [
        {
          field: '강제 종료',
          beforeValue: describeRule(row),
          afterValue: describeRule(ended),
        },
      ]);
    });
  }

  /**
   * 삭제(논리) — 시작일이 오늘 이후라 지난 날짜가 없는 휴일만. 지운 휴일은 변경 이력에만 남는다. 되살릴 수 없으니
   * 수정 · 강제 종료처럼 읽은 updatedAt 을 본다 — 그사이 고친 휴일을 옛 화면에서 지우지 않게.
   */
  async remove(
    caller: HolidayCaller,
    bpHolidayId: number,
    updatedAt: string,
    today: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockAndRead(tx, caller, bpHolidayId, updatedAt);
      if (row.startDate < today) throw new ConflictException(DELETE_STARTED);
      this.assertWhole(caller, row);
      await tx.bpHoliday.update({
        where: { bpHolidayId },
        data: { isDeleted: true, updatedBy: caller.adminAccountId },
      });
      await this.record(tx, caller, bpHolidayId, [
        { field: '삭제', beforeValue: row.name, afterValue: null },
      ]);
    });
  }

  /**
   * 휴일 행을 잠그고 다시 읽는다. 없거나 지웠거나 볼 수 없으면 404, 읽은 updatedAt 과 다르면 409. 잠금이 범위보다
   * 먼저라 다른 BP 휴일도 잠깐 잠기지만, 판정은 잠근 뒤 범위 조건으로 다시 읽은 행으로 한다.
   */
  private async lockAndRead(
    tx: Tx,
    caller: HolidayCaller,
    bpHolidayId: number,
    updatedAt: string,
  ): Promise<HolidayRow> {
    const locked = await tx.$queryRaw<{ bp_holiday_id: number }[]>`
      SELECT bp_holiday_id FROM bp_holidays
       WHERE bp_holiday_id = ${bpHolidayId} AND bp_code_id = ${caller.bpCodeId} AND NOT is_deleted
       FOR UPDATE`;
    const row = locked.length
      ? await tx.bpHoliday.findFirst({
          where: { ...visibleWhere(caller), bpHolidayId, isDeleted: false },
          select: HOLIDAY_SELECT,
        })
      : null;
    if (!row) throw new NotFoundException(NOT_FOUND);
    if (!isSameMillisecond(row.updatedAt, updatedAt))
      throw new ConflictException(CONFLICT_MESSAGE);
    return row;
  }

  private assertWhole(caller: HolidayCaller, row: HolidayRow): void {
    if (!managesWhole(caller, managedOf(row)))
      throw new ForbiddenException(
        row.isAllStores ? ALL_STORES_REASON : SHARED_REASON,
      );
  }

  /**
   * 점포 목록을 기간 행으로 반영한다. 적용 범위를 바꾸면(시작 전만) 이전 표의 열린 기간을 모두 빼고 새 표에 더한다.
   * 일부 점포 사용자는 맡은 점포만 더하거나 뺀다 — 범위 밖 점포를 빼는 요청은 403 이다.
   */
  private async applyStores(
    tx: Tx,
    caller: HolidayCaller,
    row: HolidayRow,
    dto: SaveBpHolidayDto,
    rule: HolidayRule,
    today: Date,
  ): Promise<History[]> {
    const target: TableKey = dto.isAllStores ? 'excluded' : 'mappings';
    const desired = unique(
      dto.isAllStores ? dto.excludedStoreIds : dto.storeIds,
    );
    if (!dto.isAllStores && !desired.length)
      throw new BadRequestException('대상 점포를 하나 이상 골라 주세요');
    const plans: [TableKey, PeriodPlan][] = [];
    for (const key of Object.keys(TABLES) as TableKey[]) {
      const open = openPeriodsOf<
        OpenPeriod & { effectiveEndDate: Date | null }
      >(TABLES[key].rows(row));
      plans.push([
        key,
        planStorePeriods(
          open,
          key === target ? desired : [],
          today,
          rule.startDate,
        ),
      ]);
    }
    const touched = plans.flatMap(([, p]) => [
      ...p.add.map((a) => a.storeId),
      ...p.close.map((c) => c.storeId),
      ...p.drop.map((x) => x.storeId),
    ]);
    if (touched.some((id) => !inScope(caller, id)))
      throw new ForbiddenException(OUT_OF_SCOPE);
    if (
      dto.isAllStores &&
      plans.some(([k, p]) => k === 'excluded' && hasChanges(p)) &&
      !caller.manageAll
    )
      throw new ForbiddenException(ALL_STORES_REASON);

    const names = new Map(
      [...row.storeMappings, ...row.excludedStores].map((p) => [
        p.storeId,
        p.store.name,
      ]),
    );
    const added = await this.addableStores(
      tx,
      caller,
      plans.flatMap(([, p]) => p.add.map((a) => a.storeId)),
    );
    const histories: History[] = [];
    for (const [key, plan] of plans) {
      const table = TABLES[key];
      const model = table.model(tx) as typeof tx.holidayStoreMapping;
      if (plan.add.length)
        await model.createMany({
          data: plan.add.map((a) => ({
            bpHolidayId: row.bpHolidayId,
            storeId: a.storeId,
            effectiveStartDate: a.effectiveStartDate,
            createdBy: caller.adminAccountId,
            updatedBy: caller.adminAccountId,
          })),
        });
      if (plan.close.length)
        await model.updateMany({
          where: { [table.idKey]: { in: plan.close.map((c) => c.id) } },
          data: {
            effectiveEndDate: plan.close[0].effectiveEndDate,
            updatedBy: caller.adminAccountId,
          },
        });
      if (plan.drop.length)
        await model.updateMany({
          where: { [table.idKey]: { in: plan.drop.map((x) => x.id) } },
          data: { isDeleted: true, updatedBy: caller.adminAccountId },
        });
      for (const a of plan.add)
        histories.push({
          field: table.label,
          beforeValue: null,
          afterValue: `${added.get(a.storeId)} 추가(${dateOnly(a.effectiveStartDate)}부터)`,
        });
      for (const c of plan.close)
        histories.push({
          field: table.label,
          beforeValue: names.get(c.storeId) ?? null,
          afterValue: `${names.get(c.storeId)} 빼기(${dateOnly(c.effectiveEndDate)}까지)`,
        });
      for (const x of plan.drop)
        histories.push({
          field: table.label,
          beforeValue: names.get(x.storeId) ?? null,
          afterValue: `${names.get(x.storeId)} 빼기`,
        });
    }
    return histories;
  }

  /**
   * 더할 점포를 확인하고 이름을 준다 — 그 BP 의 지우지 않은 점포여야 하고(아니면 400), 맡은 점포여야 하며(403),
   * 폐점한 점포는 더하지 않는다(400).
   */
  private async addableStores(
    tx: Tx,
    caller: HolidayCaller,
    storeIds: number[],
  ): Promise<Map<number, string>> {
    if (!storeIds.length) return new Map();
    if (storeIds.some((id) => !inScope(caller, id)))
      throw new ForbiddenException(OUT_OF_SCOPE);
    const stores = await tx.store.findMany({
      where: {
        storeId: { in: storeIds },
        bpCodeId: caller.bpCodeId,
        isDeleted: false,
      },
      select: { storeId: true, name: true, storeStatusCode: true },
    });
    if (stores.length !== new Set(storeIds).size)
      throw new BadRequestException('이 BP 의 점포가 아닌 점포가 있습니다');
    if (stores.some((s) => s.storeStatusCode === 'CLOSED'))
      throw new BadRequestException('폐점한 점포는 더할 수 없습니다');
    return new Map(stores.map((s) => [s.storeId, s.name]));
  }

  private async record(
    tx: Tx,
    caller: HolidayCaller,
    bpHolidayId: number,
    histories: History[],
  ): Promise<void> {
    await tx.bpHolidayChangeHistory.createMany({
      data: histories.map((h) => ({
        bpHolidayId,
        ...h,
        changedBy: caller.adminAccountId,
      })),
    });
  }
}

const unique = (ids: number[] | undefined): number[] => [...new Set(ids ?? [])];
const scopeLabel = (isAllStores: boolean) =>
  isAllStores ? '전체 점포' : '일부 점포';
const hasChanges = (p: PeriodPlan) =>
  p.add.length > 0 || p.close.length > 0 || p.drop.length > 0;
