import { Injectable, NotFoundException } from '@nestjs/common';
import { PreferenceCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { myContractWhere } from '../contracts/my-contract-scope';
import { myPayslipWhere } from '../payslips/my-payslips.service';
import { ACTIVE_STAFF } from '../todos/todo-rules';
import type {
  MyNotificationItemDto,
  MyNotificationListResponseDto,
  MyNotificationPreferenceDto,
  MyNotificationPreferenceListResponseDto,
} from './dto/my-notification.dto';
import type { NotificationListQueryDto } from './dto/notification-list.query.dto';
import { retentionStart, targetOf } from './staff-notification-target';

const NOT_FOUND = '알림을 찾을 수 없습니다.';

const ITEM_SELECT = {
  notificationRecipientId: true,
  isRead: true,
  createdAt: true,
  notification: {
    select: {
      templateCode: true,
      relatedType: true,
      relatedId: true,
      title: true,
      body: true,
      isUrgent: true,
    },
  },
} as const satisfies Prisma.NotificationRecipientSelect;

type Row = Prisma.NotificationRecipientGetPayload<{
  select: typeof ITEM_SELECT;
}>;

/** 수신 설정 묶음 — enum 순서대로(근로계약서 · 근무스케줄 · TO-DO · 급여명세서) */
const CATEGORIES = Object.values(PreferenceCategory);

/**
 * 직원 근무 앱 알림함(WHALEERP-265)과 알림 수신 설정(WHALEERP-268). 늘 로그인한 계정이 받은 직원 알림만 다룬다. 알림함은 모든
 * 근무지의 것을 보이고(2026-10-22 재영) 만든 지 14일 안의 것만 다룬다(NOTI-3). 수신 설정은 네 묶음 모두 끌 수 있다(NOTI-8).
 */
@Injectable()
export class MyNotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    accountId: number,
    query: NotificationListQueryDto,
    now: Date = new Date(),
  ): Promise<MyNotificationListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = mine(accountId, now);
    const [rows, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.notificationRecipient.findMany({
        where,
        select: ITEM_SELECT,
        orderBy: [{ createdAt: 'desc' }, { notificationRecipientId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationRecipient.count({ where }),
      this.prisma.notificationRecipient.count({
        where: { ...where, isRead: false },
      }),
    ]);
    return {
      items: await this.items(accountId, rows, now),
      total,
      unreadCount,
    };
  }

  /** 한 줄 읽음 · 안 읽음(NOTI-7). 알림을 눌러 이동할 때 앱이 읽음을 부른다. 이미 그 상태면 읽은 시각을 그대로 둔다 */
  async mark(
    accountId: number,
    id: number,
    isRead: boolean,
    now: Date = new Date(),
  ): Promise<MyNotificationItemDto> {
    const where = { notificationRecipientId: id, ...mine(accountId, now) };
    await this.prisma.notificationRecipient.updateMany({
      where: { ...where, isRead: !isRead },
      data: { isRead, readAt: isRead ? now : null },
    });
    const row = await this.prisma.notificationRecipient.findFirst({
      where,
      select: ITEM_SELECT,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return (await this.items(accountId, [row], now))[0];
  }

  async readAll(
    accountId: number,
    now: Date = new Date(),
  ): Promise<{ updated: number }> {
    const { count } = await this.prisma.notificationRecipient.updateMany({
      where: { ...mine(accountId, now), isRead: false },
      data: { isRead: true, readAt: now },
    });
    return { updated: count };
  }

  /** 네 묶음의 수신 여부. 행이 없으면 켜짐(NTF-14 · 21) */
  async preferences(
    accountId: number,
  ): Promise<MyNotificationPreferenceListResponseDto> {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { accountId },
      select: { preferenceCategory: true, isEnabled: true },
    });
    const off = new Set(
      rows.filter((r) => !r.isEnabled).map((r) => r.preferenceCategory),
    );
    return {
      items: CATEGORIES.map((category) => ({
        category,
        isEnabled: !off.has(category),
      })),
    };
  }

  /** 한 묶음을 켜고 끈다. 그 뒤에 생기는 알림부터 든다 — 만드는 쪽이 만들 때 이 행을 읽는다 */
  async setPreference(
    accountId: number,
    category: PreferenceCategory,
    isEnabled: boolean,
  ): Promise<MyNotificationPreferenceDto> {
    await this.prisma.notificationPreference.upsert({
      where: {
        accountId_preferenceCategory: {
          accountId,
          preferenceCategory: category,
        },
      },
      create: { accountId, preferenceCategory: category, isEnabled },
      update: { isEnabled },
    });
    return { category, isEnabled };
  }

  /** 줄 → 화면 값. 수신 설정 묶음은 지금 템플릿에서, 갈 곳은 관련 업무와 내 재직 소속에서 한 번에 읽는다 */
  private async items(
    accountId: number,
    rows: Row[],
    now: Date,
  ): Promise<MyNotificationItemDto[]> {
    const ids = (type: string) => [
      ...new Set(
        rows
          .filter((r) => r.notification.relatedType === type)
          .map((r) => r.notification.relatedId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const scheduleIds = ids('WORK_SCHEDULE');
    const todoIds = ids('TODO');
    const contractIds = ids('CONTRACT');
    const payslipIds = ids('PAYSLIP');
    const codes = [...new Set(rows.map((r) => r.notification.templateCode))];
    // 빈 목록이면 in: [] 이라 빈 결과다 — 쿼리 수를 줄이려고 갈래를 두지 않는다(한 화면 20줄)
    const [templates, memberships, schedules, todos, contracts, payslips] =
      await Promise.all([
        this.prisma.notificationTemplate.findMany({
          where: { templateCode: { in: codes } },
          select: { templateCode: true, preferenceCategory: true },
        }),
        this.prisma.staffMember.findMany({
          where: { accountId, ...ACTIVE_STAFF },
          select: { staffMemberId: true, storeId: true },
        }),
        // 지운 근무스케줄도 읽는다 — 삭제 알림도 그 날짜의 달력으로 간다
        this.prisma.workSchedule.findMany({
          where: { workScheduleId: { in: scheduleIds } },
          select: { workScheduleId: true, staffMemberId: true, startAt: true },
        }),
        this.prisma.todo.findMany({
          where: { todoId: { in: todoIds }, isDeleted: false },
          select: { todoId: true, storeId: true },
        }),
        // 직원 앱이 열 수 있는 내 계약 · 명세서만 — 각 화면의 조회와 같은 조건이다
        this.prisma.contract.findMany({
          where: {
            contractId: { in: contractIds },
            ...myContractWhere(accountId),
          },
          select: { contractId: true, staffMemberId: true },
        }),
        this.prisma.payslip.findMany({
          where: {
            payslipId: { in: payslipIds },
            ...myPayslipWhere(accountId, now),
          },
          select: { payslipId: true },
        }),
      ]);
    const categoryOf = new Map(
      templates.map((t) => [t.templateCode, t.preferenceCategory]),
    );
    const ctx = {
      myStaffMemberIds: new Set(memberships.map((m) => m.staffMemberId)),
      myStaffMemberOfStore: new Map(
        memberships.map((m) => [m.storeId, m.staffMemberId]),
      ),
      schedules: new Map(schedules.map((s) => [s.workScheduleId, s])),
      todos: new Map(todos.map((t) => [t.todoId, t])),
      contracts: new Map(contracts.map((c) => [c.contractId, c])),
      payslips: new Set(payslips.map((p) => p.payslipId)),
    };
    return rows.map((r) => ({
      id: r.notificationRecipientId,
      templateCode: r.notification.templateCode,
      category: categoryOf.get(r.notification.templateCode) ?? null,
      title: r.notification.title,
      body: r.notification.body,
      isUrgent: r.notification.isUrgent,
      isRead: r.isRead,
      createdAt: r.createdAt,
      target: targetOf(r.notification, ctx),
    }));
  }
}

/** 내 계정이 받은 직원 알림, 지우지 않은 것, 받은 지 14일 안(NOTI-3) */
function mine(
  accountId: number,
  now: Date,
): Prisma.NotificationRecipientWhereInput {
  return {
    accountId,
    isDeleted: false,
    createdAt: { gte: retentionStart(now) },
    notification: { notificationTarget: 'STAFF' },
  };
}
