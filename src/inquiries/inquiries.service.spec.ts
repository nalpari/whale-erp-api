import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { InquiriesService } from './inquiries.service';

// 규칙의 경계만 목으로 본다. 동시 저장의 409 가 실제 DB 에서도 나는지는 e2e 가 증명한다.
// updateMany 인자의 모양. mock.calls 를 any 로 꺼내 쓰지 않게 한다.
type UpdateMany = jest.Mock<
  Promise<{ count: number }>,
  [{ where: Record<string, unknown>; data: Record<string, unknown> }]
>;

describe('InquiriesService', () => {
  let service: InquiriesService;
  let prisma: {
    $transaction: jest.Mock;
    inquiry: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: UpdateMany;
    };
    inquiryReply: { create: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
  };
  let ops: { notify: jest.Mock };
  let mail: { send: jest.Mock } | null;
  let adminWebUrl: string | undefined;

  const updatedAt = new Date('2026-10-14T01:02:03.456Z');
  const inquiry = (overrides: Record<string, unknown> = {}) => ({
    inquiryId: 7,
    status: 'RECEIVED',
    createdBy: 21,
    title: '급여명세서 공제 항목 문의',
    updatedAt,
    ...overrides,
  });

  async function build() {
    const module = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpsNotificationService, useValue: ops },
        { provide: OPTIONAL_MAIL_SERVICE, useValue: mail },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'ADMIN_WEB_URL' ? adminWebUrl : undefined,
          },
        },
      ],
    }).compile();
    service = module.get(InquiriesService);
  }

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      inquiry: {
        findUnique: jest.fn().mockResolvedValue(inquiry()),
        // 트랜잭션 안의 상태 읽기. 같은 목을 거치게 해 테스트가 읽기 순서를 한 줄로 본다.
        findUniqueOrThrow: jest.fn((args: unknown): unknown =>
          prisma.inquiry.findUnique(args),
        ),
        updateMany: (jest.fn() as UpdateMany).mockResolvedValue({ count: 1 }),
      },
      inquiryReply: { create: jest.fn().mockResolvedValue({}) },
      adminAccount: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ adminAccountId: 21, email: 'bp@test.invalid' }),
      },
    };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm' }) };
    adminWebUrl = 'https://admin.test.invalid';
    await build();
  });

  describe('startProcessing', () => {
    it('접수 상태만 처리중으로 바꾸고 바꾼 관리자 · 시각을 함께 남긴다', async () => {
      await service.startProcessing(3, 7);
      const [{ where, data }] = prisma.inquiry.updateMany.mock.calls[0];
      expect(where).toEqual({ inquiryId: 7, status: 'RECEIVED' });
      expect(data).toMatchObject({
        status: 'IN_PROGRESS',
        processingStartedBy: 3,
      });
      expect(data.processingStartedAt).toBeInstanceOf(Date);
    });

    it('없는 문의는 404', async () => {
      prisma.inquiry.updateMany.mockResolvedValue({ count: 0 });
      prisma.inquiry.findUnique.mockResolvedValue(null);
      await expect(service.startProcessing(3, 7)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each(['IN_PROGRESS', 'ANSWERED'])(
      '이미 %s 인 문의는 409',
      async (status) => {
        prisma.inquiry.updateMany.mockResolvedValue({ count: 0 });
        prisma.inquiry.findUnique.mockResolvedValue(inquiry({ status }));
        await expect(service.startProcessing(3, 7)).rejects.toThrow(
          ConflictException,
        );
      },
    );

    it('바뀐 상태와 다음 저장에 쓸 updatedAt 을 돌려준다', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(
        inquiry({ status: 'IN_PROGRESS' }),
      );
      await expect(service.startProcessing(3, 7)).resolves.toMatchObject({
        inquiryId: 7,
        status: 'IN_PROGRESS',
        updatedAt,
      });
    });
  });

  describe('reply', () => {
    const dto = { body: '답변입니다', updatedAt: updatedAt.toISOString() };

    it('읽은 뒤 아무도 고치지 않았을 때만 답변 완료로 바꾸고 답변 행을 더한다', async () => {
      await service.reply(3, 7, dto);
      const [{ where, data }] = prisma.inquiry.updateMany.mock.calls[0];
      expect(where).toEqual({
        inquiryId: 7,
        updatedAt: {
          gte: updatedAt,
          lt: new Date(updatedAt.getTime() + 1),
        },
      });
      expect(data).toEqual({ status: 'ANSWERED' });
      expect(prisma.inquiryReply.create).toHaveBeenCalledWith({
        data: { inquiryId: 7, body: '답변입니다', repliedBy: 3 },
      });
    });

    it('없는 문의는 404 이고 아무것도 쓰지 않는다', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(null);
      await expect(service.reply(3, 7, dto)).rejects.toThrow(NotFoundException);
      expect(prisma.inquiry.updateMany).not.toHaveBeenCalled();
    });

    it('그사이 누가 고쳤으면 409 이고 답변 행을 더하지 않고 알리지도 않는다', async () => {
      prisma.inquiry.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reply(3, 7, dto)).rejects.toThrow(ConflictException);
      expect(prisma.inquiryReply.create).not.toHaveBeenCalled();
      expect(ops.notify).not.toHaveBeenCalled();
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it.each(['RECEIVED', 'IN_PROGRESS'])(
      '첫 답변(%s 에서)이면 등록자에게 운영 알림과 메일을 보낸다',
      async (status) => {
        prisma.inquiry.findUnique.mockResolvedValue(inquiry({ status }));
        await service.reply(3, 7, dto);
        expect(ops.notify).toHaveBeenCalledWith({
          templateCode: 'NTF_INQUIRY_ANSWERED',
          variables: { 문의제목: '급여명세서 공제 항목 문의' },
          related: { type: 'INQUIRY', id: 7 },
          link: '/support/inquiries/7',
          eventKey: '7',
          recipients: [21],
        });
        expect(mail!.send).toHaveBeenCalledWith({
          templateCode: 'EMAIL_INQUIRY_ANSWERED',
          to: 'bp@test.invalid',
          variables: {
            문의제목: '급여명세서 공제 항목 문의',
            링크: 'https://admin.test.invalid/support/inquiries/7',
          },
          adminAccountId: 21,
          sentBy: 3,
        });
      },
    );

    it('답변을 고칠 때(이미 답변 완료)는 새 행만 더하고 알리지 않는다(CNT-17)', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(
        inquiry({ status: 'ANSWERED' }),
      );
      await service.reply(3, 7, dto);
      expect(prisma.inquiryReply.create).toHaveBeenCalled();
      expect(ops.notify).not.toHaveBeenCalled();
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('등록자가 사용 중인 계정이 아니면 아무에게도 보내지 않는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await service.reply(3, 7, dto);
      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: [] }),
      );
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('응답 상태는 저장한 트랜잭션 안에서 읽는다 — 알림 · 메일을 기다리는 사이 남이 저장한 값을 돌려주지 않는다', async () => {
      const mine = new Date('2026-10-14T01:05:00.000Z');
      prisma.inquiry.findUnique
        .mockResolvedValueOnce(inquiry()) // 저장 전 상태
        .mockResolvedValueOnce(
          inquiry({ status: 'ANSWERED', updatedAt: mine }),
        );
      // 메일을 보내는 동안 다른 운영자가 메모를 저장했다.
      ops.notify.mockImplementation(() => {
        prisma.inquiry.findUnique.mockReset().mockResolvedValue(
          inquiry({
            status: 'ANSWERED',
            updatedAt: new Date('2026-10-14T01:06:00.000Z'),
          }),
        );
        return Promise.resolve(null);
      });
      await expect(service.reply(3, 7, dto)).resolves.toMatchObject({
        updatedAt: mine,
      });
    });

    it('커밋 뒤 알림 쪽에서 DB 오류가 나도 답변 저장은 성공이다', async () => {
      prisma.adminAccount.findFirst.mockRejectedValue(new Error('db down'));
      await expect(service.reply(3, 7, dto)).resolves.toMatchObject({
        inquiryId: 7,
      });
    });

    it('메일이 실패해도 답변 저장은 성공이다', async () => {
      mail!.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.reply(3, 7, dto)).resolves.toMatchObject({
        inquiryId: 7,
      });
    });

    it('MAIL_* 가 없으면 메일만 건너뛴다', async () => {
      mail = null;
      await build();
      await service.reply(3, 7, dto);
      expect(ops.notify).toHaveBeenCalled();
    });

    it('ADMIN_WEB_URL 이 없으면 메일만 건너뛴다(버튼 링크가 필수다)', async () => {
      adminWebUrl = undefined;
      await build();
      await service.reply(3, 7, dto);
      expect(ops.notify).toHaveBeenCalled();
      expect(mail!.send).not.toHaveBeenCalled();
    });
  });

  describe('saveInternalMemo', () => {
    const dto = {
      internalMemo: '전화 확인함',
      updatedAt: updatedAt.toISOString(),
    };

    it('읽은 뒤 아무도 고치지 않았을 때만 메모를 저장한다', async () => {
      await service.saveInternalMemo(7, dto);
      const [{ where, data }] = prisma.inquiry.updateMany.mock.calls[0];
      expect(where.inquiryId).toBe(7);
      expect(where.updatedAt).toBeDefined();
      expect(data).toEqual({ internalMemo: '전화 확인함' });
    });

    it('빈 메모는 지운다(null)', async () => {
      await service.saveInternalMemo(7, { ...dto, internalMemo: '  ' });
      expect(prisma.inquiry.updateMany.mock.calls[0][0].data).toEqual({
        internalMemo: null,
      });
    });

    it('없는 문의는 404, 그사이 고쳤으면 409', async () => {
      prisma.inquiry.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.saveInternalMemo(7, dto)).rejects.toThrow(
        ConflictException,
      );
      prisma.inquiry.findUnique.mockResolvedValue(null);
      await expect(service.saveInternalMemo(7, dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
