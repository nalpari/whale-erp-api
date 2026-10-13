import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const createdAt = new Date('2026-10-13T01:00:00Z');
const row = (over: object = {}) => ({
  notificationRecipientId: 70,
  isRead: false,
  createdAt,
  notification: {
    templateCode: 'NTF_CONTRACT_SIGNED',
    relatedType: 'CONTRACT',
    relatedId: 41,
    title: '문태경 님이 근로계약서에 날인했습니다',
    body: '온기식당 판교점',
  },
  ...over,
});

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    notificationRecipient: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock<
        Promise<{ count: number }>,
        [Prisma.NotificationRecipientUpdateManyArgs]
      >;
    };
    notificationTemplate: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ adminAccountId: 3 }),
      },
      notificationRecipient: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findFirst: jest.fn().mockResolvedValue(row({ isRead: true })),
        count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
        updateMany: jest
          .fn<
            Promise<{ count: number }>,
            [Prisma.NotificationRecipientUpdateManyArgs]
          >()
          .mockResolvedValue({ count: 1 }),
      },
      notificationTemplate: {
        findMany: jest.fn().mockResolvedValue([
          {
            templateCode: 'NTF_CONTRACT_SIGNED',
            templateName: '근로계약 날인',
          },
        ]),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  const mine = { adminAccountId: 3, isDeleted: false };

  describe('list', () => {
    it('내 알림만 최신순으로 한 페이지 주고 전체·미확인 건수를 함께 준다', async () => {
      await expect(service.list(3, { page: 2, pageSize: 20 })).resolves.toEqual(
        {
          items: [
            {
              id: 70,
              templateCode: 'NTF_CONTRACT_SIGNED',
              kind: '근로계약 날인',
              title: '문태경 님이 근로계약서에 날인했습니다',
              body: '온기식당 판교점',
              relatedType: 'CONTRACT',
              relatedId: 41,
              isRead: false,
              createdAt,
            },
          ],
          total: 1,
          unreadCount: 1,
        },
      );
      expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: mine,
          orderBy: [{ createdAt: 'desc' }, { notificationRecipientId: 'desc' }],
          skip: 20,
          take: 20,
        }),
      );
      expect(prisma.notificationRecipient.count).toHaveBeenNthCalledWith(1, {
        where: mine,
      });
      expect(prisma.notificationRecipient.count).toHaveBeenNthCalledWith(2, {
        where: { ...mine, isRead: false },
      });
    });

    it('기본은 1쪽 20건이다', async () => {
      await service.list(3, {});

      expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('템플릿이 없으면 구분에 템플릿 코드를 그대로 쓴다', async () => {
      prisma.notificationTemplate.findMany.mockResolvedValue([]);

      const { items } = await service.list(3, {});
      expect(items[0].kind).toBe('NTF_CONTRACT_SIGNED');
    });

    it('사용 중인 관리자가 아니면 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(service.list(3, {})).rejects.toThrow(ForbiddenException);
      expect(prisma.notificationRecipient.findMany).not.toHaveBeenCalled();
    });
  });

  describe('read', () => {
    it('내 미확인 알림을 읽음으로 바꾸고 그 한 줄을 준다', async () => {
      const item = await service.read(3, 70);

      expect(prisma.notificationRecipient.updateMany).toHaveBeenCalledWith({
        where: { notificationRecipientId: 70, ...mine, isRead: false },
        data: { isRead: true, readAt: expect.any(Date) as Date },
      });
      expect(item).toMatchObject({
        id: 70,
        relatedType: 'CONTRACT',
        relatedId: 41,
        isRead: true,
      });
    });

    it('이미 읽은 알림이어도 200 이고 읽은 시각은 처음 값 그대로다', async () => {
      prisma.notificationRecipient.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.read(3, 70)).resolves.toMatchObject({ id: 70 });
      // 조건에 isRead: false 가 있어 이미 읽은 행의 readAt 은 바뀌지 않는다.
      expect(
        prisma.notificationRecipient.updateMany.mock.calls[0][0].where,
      ).toMatchObject({ isRead: false });
    });

    it('내 것이 아니거나 지운 알림이면 404', async () => {
      prisma.notificationRecipient.findFirst.mockResolvedValue(null);

      await expect(service.read(3, 70)).rejects.toThrow(NotFoundException);
      expect(prisma.notificationRecipient.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { notificationRecipientId: 70, ...mine },
        }),
      );
    });

    it('사용 중인 관리자가 아니면 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(service.read(3, 70)).rejects.toThrow(ForbiddenException);
      expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('readAll', () => {
    it('내 미확인 알림만 모두 읽음으로 바꾼다', async () => {
      prisma.notificationRecipient.updateMany.mockResolvedValue({ count: 4 });

      await expect(service.readAll(3)).resolves.toEqual({ updated: 4 });
      expect(prisma.notificationRecipient.updateMany).toHaveBeenCalledWith({
        where: { ...mine, isRead: false },
        data: { isRead: true, readAt: expect.any(Date) as Date },
      });
    });
  });

  describe('remove', () => {
    it('고른 것 가운데 내 알림만 지운 표시를 한다', async () => {
      await service.remove(3, [70, 71]);

      expect(prisma.notificationRecipient.updateMany).toHaveBeenCalledWith({
        where: { notificationRecipientId: { in: [70, 71] }, ...mine },
        data: { isDeleted: true },
      });
    });

    it('사용 중인 관리자가 아니면 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(service.remove(3, [70])).rejects.toThrow(ForbiddenException);
    });
  });
});
