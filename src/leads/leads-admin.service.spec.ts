import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsAdminService } from './leads-admin.service';

// 규칙의 경계만 목으로 본다. 동시 저장의 409 가 실제 DB 에서도 나는지는 e2e 가 증명한다.
// updateMany 인자의 모양. mock.calls 를 any 로 꺼내 쓰지 않게 한다.
type UpdateMany = jest.Mock<
  Promise<{ count: number }>,
  [{ where: Record<string, unknown>; data: Record<string, unknown> }]
>;

// 운영 알림은 응답을 기다리게 하지 않고 뒤에서 보낸다. 그 일이 끝날 때까지 기다린다.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('LeadsAdminService', () => {
  let service: LeadsAdminService;
  let prisma: {
    $transaction: jest.Mock;
    lead: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: UpdateMany;
    };
    adminAccount: { findMany: jest.Mock };
    codeItem: { findFirst: jest.Mock };
  };
  let ops: { notify: jest.Mock };
  let logged: { error: jest.SpyInstance };
  // 저장한 트랜잭션 안에서 읽은 상태. 트랜잭션 밖 읽기(findUnique)와 다른 값이라 어느 쪽을 돌려줬는지 가린다.
  const saved = {
    leadId: 5,
    status: 'ANSWERED',
    updatedAt: new Date('2026-10-14T01:05:00.000Z'),
  };

  const updatedAt = new Date('2026-10-14T01:02:03.456Z');
  // 한국 시간 10-14 00:30 — UTC 로는 아직 10-13 이다. 상담 완료일은 한국 날짜여야 한다.
  const now = new Date('2026-10-13T15:30:00Z');
  const lead = (overrides: Record<string, unknown> = {}) => ({
    leadId: 5,
    status: 'RECEIVED',
    contactName: '김도윤',
    industryCode: 'CAFE',
    industryDetail: null,
    consultedDate: null,
    updatedAt,
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      lead: {
        findUnique: jest.fn().mockResolvedValue(lead()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(saved),
        updateMany: (jest.fn() as UpdateMany).mockResolvedValue({ count: 1 }),
      },
      adminAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminAccountId: 1 }, { adminAccountId: 2 }]),
      },
      codeItem: { findFirst: jest.fn().mockResolvedValue({ label: '카페' }) },
    };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    const module = await Test.createTestingModule({
      providers: [
        LeadsAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpsNotificationService, useValue: ops },
      ],
    }).compile();
    service = module.get(LeadsAdminService);
    logged = {
      error: jest.spyOn(service['logger'], 'error').mockImplementation(),
    };
  });

  afterEach(() => jest.useRealTimers());

  // 바꾼 행은 행 잠금을 쥔 트랜잭션 안에서 읽는다 — 커밋 뒤에 읽으면 그사이 남이 저장한 updatedAt 을 돌려준다.
  it.each([
    ['startProcessing', () => service.startProcessing(3, 5)],
    [
      'reply',
      () =>
        service.reply(3, 5, { reply: 'x', updatedAt: updatedAt.toISOString() }),
    ],
    [
      'saveInternalMemo',
      () =>
        service.saveInternalMemo(5, {
          internalMemo: 'x',
          updatedAt: updatedAt.toISOString(),
        }),
    ],
  ] as const)(
    '%s 는 바꾼 상태를 같은 트랜잭션 안에서 읽어 돌려준다',
    async (_, run) => {
      await expect(run()).resolves.toEqual(saved);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.lead.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { leadId: 5 },
        select: { leadId: true, status: true, updatedAt: true },
      });
    },
  );

  describe('startProcessing', () => {
    it('접수 상태만 처리중으로 바꾸고 바꾼 관리자 · 시각을 함께 남긴다', async () => {
      await service.startProcessing(3, 5);
      expect(prisma.lead.updateMany).toHaveBeenCalledWith({
        where: { leadId: 5, status: 'RECEIVED' },
        data: {
          status: 'IN_PROGRESS',
          processingStartedBy: 3,
          processingStartedAt: now,
        },
      });
    });

    it('없으면 404, 이미 처리중 · 답변이면 409', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 0 });
      prisma.lead.findUnique.mockResolvedValue(lead({ status: 'ANSWERED' }));
      await expect(service.startProcessing(3, 5)).rejects.toThrow(
        new ConflictException('이미 답변한 도입문의입니다'),
      );
      prisma.lead.findUnique.mockResolvedValue(lead({ status: 'IN_PROGRESS' }));
      await expect(service.startProcessing(3, 5)).rejects.toThrow(
        new ConflictException('이미 처리중인 도입문의입니다'),
      );
      prisma.lead.findUnique.mockResolvedValue(null);
      await expect(service.startProcessing(3, 5)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reply', () => {
    const dto = { reply: '연락드렸습니다', updatedAt: updatedAt.toISOString() };

    it.each(['RECEIVED', 'IN_PROGRESS'])(
      '첫 답변(%s 에서)이면 답변자 · 시각과 한국 날짜 상담 완료일을 남긴다',
      async (status) => {
        prisma.lead.findUnique.mockResolvedValue(lead({ status }));
        await service.reply(3, 5, dto);
        expect(prisma.lead.updateMany).toHaveBeenCalledWith({
          where: {
            leadId: 5,
            updatedAt: {
              gte: updatedAt,
              lt: new Date(updatedAt.getTime() + 1),
            },
          },
          data: {
            reply: '연락드렸습니다',
            repliedBy: 3,
            repliedAt: now,
            status: 'ANSWERED',
            consultedDate: new Date('2026-10-14T00:00:00Z'),
          },
        });
      },
    );

    it('상담 완료일이 이미 있으면 다시 쓰지 않는다(답변을 고칠 때)', async () => {
      prisma.lead.findUnique.mockResolvedValue(
        lead({ status: 'ANSWERED', consultedDate: new Date('2026-01-02') }),
      );
      await service.reply(3, 5, dto);
      const [{ data }] = prisma.lead.updateMany.mock.calls[0];
      expect(data).not.toHaveProperty('consultedDate');
      expect(data).toMatchObject({ reply: '연락드렸습니다', repliedBy: 3 });
    });

    it('없으면 404 이고 아무것도 쓰지 않는다', async () => {
      prisma.lead.findUnique.mockResolvedValue(null);
      await expect(service.reply(3, 5, dto)).rejects.toThrow(NotFoundException);
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('그사이 누가 저장했으면 409', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reply(3, 5, dto)).rejects.toThrow(ConflictException);
    });
  });

  describe('상담 완료일', () => {
    const dto = { reply: '연락드렸습니다', updatedAt: updatedAt.toISOString() };

    it('상태가 이미 답변완료여도 상담 완료일이 비어 있으면 채운다 — 손으로 답변완료가 된 행도 파기 대상에 든다', async () => {
      prisma.lead.findUnique.mockResolvedValue(lead({ status: 'ANSWERED' }));
      await service.reply(3, 5, dto);
      const [{ data }] = prisma.lead.updateMany.mock.calls[0];
      expect(data.consultedDate).toEqual(new Date('2026-10-14T00:00:00Z'));
    });
  });

  // 도입문의 처리 상태가 바뀌면 플랫폼 운영자에게 알린다(NTF_LEAD_ANSWERED, 운영 정책 NTF-01 · 04, 2026-10-14 재영).
  describe('처리 상태 변경 운영 알림', () => {
    const dto = { reply: '연락드렸습니다', updatedAt: updatedAt.toISOString() };
    const notified = (status: 'IN_PROGRESS' | 'ANSWERED', label: string) => ({
      templateCode: 'NTF_LEAD_ANSWERED',
      variables: { 처리상태: label, 도입문의자: '김도윤 · 카페' },
      related: { type: 'LEAD', id: 5 },
      link: '/platform/community/leads/5',
      eventKey: `5:${status}`,
      recipients: [1, 2],
    });

    it('처리중으로 바꾸면 플랫폼 운영자에게 알린다', async () => {
      await service.startProcessing(3, 5);
      await settle();
      expect(ops.notify).toHaveBeenCalledWith(
        notified('IN_PROGRESS', '처리중'),
      );
    });

    it.each(['RECEIVED', 'IN_PROGRESS'])(
      '%s 에서 답변완료가 되면 알린다',
      async (status) => {
        prisma.lead.findUnique.mockResolvedValue(lead({ status }));
        await service.reply(3, 5, dto);
        await settle();
        expect(ops.notify).toHaveBeenCalledWith(
          notified('ANSWERED', '답변완료'),
        );
      },
    );

    it('답변을 고칠 때(상태가 그대로)는 알리지 않는다', async () => {
      prisma.lead.findUnique.mockResolvedValue(lead({ status: 'ANSWERED' }));
      await service.reply(3, 5, dto);
      await settle();
      expect(ops.notify).not.toHaveBeenCalled();
    });

    it('409 면 알리지 않는다', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.startProcessing(3, 5)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.reply(3, 5, dto)).rejects.toThrow(ConflictException);
      await settle();
      expect(ops.notify).not.toHaveBeenCalled();
    });

    it('업종이 기타면 직접 입력한 업종을 쓴다', async () => {
      prisma.lead.findUnique.mockResolvedValue(
        lead({ industryCode: 'ETC', industryDetail: '꽃집' }),
      );
      await service.startProcessing(3, 5);
      await settle();
      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { 처리상태: '처리중', 도입문의자: '김도윤 · 꽃집' },
        }),
      );
    });

    it('알림 준비가 실패해도 처리중 전환은 성공이고 로그만 남는다', async () => {
      prisma.adminAccount.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.startProcessing(3, 5)).resolves.toEqual(saved);
      await settle();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('lead status notification FAILED'),
      );
    });
  });

  describe('saveInternalMemo', () => {
    const dto = {
      internalMemo: '재통화 예정',
      updatedAt: updatedAt.toISOString(),
    };

    it('읽은 뒤 아무도 저장하지 않았을 때만 메모를 저장하고, 빈 메모는 지운다', async () => {
      await service.saveInternalMemo(5, dto);
      await service.saveInternalMemo(5, { ...dto, internalMemo: null });
      const calls = prisma.lead.updateMany.mock.calls;
      expect(calls[0][0].data).toEqual({ internalMemo: '재통화 예정' });
      expect(calls[0][0].where).toEqual({
        leadId: 5,
        updatedAt: { gte: updatedAt, lt: new Date(updatedAt.getTime() + 1) },
      });
      expect(calls[1][0].data).toEqual({ internalMemo: null });
    });

    it('없으면 404, 그사이 저장했으면 409', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.saveInternalMemo(5, dto)).rejects.toThrow(
        ConflictException,
      );
      prisma.lead.findUnique.mockResolvedValue(null);
      await expect(service.saveInternalMemo(5, dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
