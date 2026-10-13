import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationListQueryDto } from './dto/notification-list.query.dto';
import type {
  NotificationItemDto,
  NotificationListResponseDto,
} from './dto/notification-item.response.dto';
import { splitTitle } from './ops-notification.service';
import { activeAdmin } from './recipients';
import type { RelatedType } from './related-type';

const ITEM_SELECT = {
  notificationRecipientId: true,
  isRead: true,
  createdAt: true,
  notification: {
    select: {
      templateCode: true,
      relatedType: true,
      relatedId: true,
      body: true,
    },
  },
} as const;

type Row = {
  notificationRecipientId: number;
  isRead: boolean;
  createdAt: Date;
  notification: {
    templateCode: string;
    relatedType: string | null;
    relatedId: number | null;
    body: string;
  };
};

/**
 * 관리자 웹 운영 알림함(WHALEERP-251 · 252). 늘 내 수신 행(admin_account_id = 나, 지우지 않은 것)만 다룬다.
 * 가드는 관리자 계정이 사용 중인지 보지 않으므로 여기서 다시 확인한다.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    adminAccountId: number,
    query: NotificationListQueryDto,
  ): Promise<NotificationListResponseDto> {
    await this.assertActive(adminAccountId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = mine(adminAccountId);

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
    const kinds = await this.kinds(rows);
    return { items: rows.map((r) => toItem(r, kinds)), total, unreadCount };
  }

  /** 알림을 눌러 이동할 때(NTF-06). 이미 읽은 알림이면 읽은 시각을 그대로 둔다. */
  async read(adminAccountId: number, id: number): Promise<NotificationItemDto> {
    await this.assertActive(adminAccountId);
    const where = { notificationRecipientId: id, ...mine(adminAccountId) };
    await this.prisma.notificationRecipient.updateMany({
      where: { ...where, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    const row = await this.prisma.notificationRecipient.findFirst({
      where,
      select: ITEM_SELECT,
    });
    if (!row) throw new NotFoundException('알림을 찾을 수 없습니다');
    return toItem(row, await this.kinds([row]));
  }

  async readAll(adminAccountId: number): Promise<{ updated: number }> {
    await this.assertActive(adminAccountId);
    const { count } = await this.prisma.notificationRecipient.updateMany({
      where: { ...mine(adminAccountId), isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: count };
  }

  /** 선택 삭제 — 받은 사람별로 지운 표시만 한다. 다른 받는 사람의 알림은 그대로다. */
  async remove(adminAccountId: number, ids: number[]): Promise<void> {
    await this.assertActive(adminAccountId);
    await this.prisma.notificationRecipient.updateMany({
      where: { notificationRecipientId: { in: ids }, ...mine(adminAccountId) },
      data: { isDeleted: true },
    });
  }

  private async assertActive(adminAccountId: number): Promise<void> {
    if ((await activeAdmin(this.prisma, adminAccountId)).length === 0)
      throw new ForbiddenException('사용 중인 관리자 계정이 아닙니다');
  }

  /** 구분 칸 — 템플릿 코드를 지금 템플릿 이름으로. 외래키가 없어 없는 코드는 비어 있다 */
  private async kinds(rows: Row[]): Promise<Map<string, string>> {
    const codes = [...new Set(rows.map((r) => r.notification.templateCode))];
    if (codes.length === 0) return new Map();
    const templates = await this.prisma.notificationTemplate.findMany({
      where: { templateCode: { in: codes } },
      select: { templateCode: true, templateName: true },
    });
    return new Map(templates.map((t) => [t.templateCode, t.templateName]));
  }
}

function mine(adminAccountId: number) {
  return { adminAccountId, isDeleted: false };
}

function toItem(row: Row, kinds: Map<string, string>): NotificationItemDto {
  const { templateCode, relatedType, relatedId, body } = row.notification;
  return {
    id: row.notificationRecipientId,
    templateCode,
    kind: kinds.get(templateCode) ?? templateCode,
    ...splitTitle(body),
    relatedType: relatedType as RelatedType | null,
    relatedId,
    isRead: row.isRead,
    createdAt: row.createdAt,
  };
}
