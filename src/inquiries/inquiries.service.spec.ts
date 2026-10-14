import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { InquiriesService } from './inquiries.service';

// updateMany 인자의 모양. mock.calls 를 any 로 꺼내 쓰지 않게 한다.
type UpdateMany = jest.Mock<
  Promise<{ count: number }>,
  [{ where: Record<string, unknown>; data: Record<string, unknown> }]
>;

// 알림 · 메일은 응답을 기다리게 하지 않고 뒤에서 보낸다. 그 일이 끝날 때까지 기다린다.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 규칙의 경계만 목으로 본다. 동시 저장의 409 가 실제 DB 에서도 나는지는 e2e 가 증명한다.
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
  let logged: { warn: jest.SpyInstance; error: jest.SpyInstance };

  const updatedAt = new Date('2026-10-14T01:02:03.456Z');
  // 저장한 트랜잭션 안에서 읽은 상태. 트랜잭션 밖 읽기(findUnique)와 다른 값이라 어느 쪽을 돌려줬는지 가린다.
  const saved = {
    inquiryId: 7,
    status: 'ANSWERED',
    updatedAt: new Date('2026-10-14T01:05:00.000Z'),
  };
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
    logged = {
      warn: jest.spyOn(service['logger'], 'warn').mockImplementation(),
      error: jest.spyOn(service['logger'], 'error').mockImplementation(),
    };
  }

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      inquiry: {
        findUnique: jest.fn().mockResolvedValue(inquiry()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(saved),
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

  // 저장한 행은 행 잠금을 쥔 트랜잭션 안에서 읽는다. 커밋 뒤에 따로 읽으면 그사이 다른 운영자가 저장한
  // updatedAt 을 돌려줘, 이 운영자의 다음 저장이 409 없이 남의 저장을 덮는다.
  const readInsideTransaction = () => {
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.inquiry.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { inquiryId: 7 },
      select: { inquiryId: true, status: true, updatedAt: true },
    });
  };

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

    it('바꾼 상태를 같은 트랜잭션 안에서 읽어 돌려준다', async () => {
      await expect(service.startProcessing(3, 7)).resolves.toEqual(saved);
      readInsideTransaction();
    });

    it('없는 문의는 404', async () => {
      prisma.inquiry.updateMany.mockResolvedValue({ count: 0 });
      prisma.inquiry.findUnique.mockResolvedValue(null);
      await expect(service.startProcessing(3, 7)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([
      ['IN_PROGRESS', '이미 처리중인 문의입니다'],
      ['ANSWERED', '이미 답변한 문의입니다'],
    ])('이미 %s 인 문의는 409 — %s', async (status, message) => {
      prisma.inquiry.updateMany.mockResolvedValue({ count: 0 });
      prisma.inquiry.findUnique.mockResolvedValue(inquiry({ status }));
      await expect(service.startProcessing(3, 7)).rejects.toThrow(
        new ConflictException(message),
      );
    });
  });

  describe('reply', () => {
    const dto = { body: '답변입니다', updatedAt: updatedAt.toISOString() };
    const sameMs = {
      gte: updatedAt,
      lt: new Date(updatedAt.getTime() + 1),
    };

    it('읽은 뒤 아무도 고치지 않았을 때만 답변 완료로 바꾸고 답변 행을 더한다', async () => {
      await service.reply(3, 7, dto);
      const [{ where, data }] = prisma.inquiry.updateMany.mock.calls[0];
      expect(where).toEqual({ inquiryId: 7, updatedAt: sameMs });
      expect(data).toEqual({ status: 'ANSWERED' });
      expect(prisma.inquiryReply.create).toHaveBeenCalledWith({
        data: { inquiryId: 7, body: '답변입니다', repliedBy: 3 },
      });
    });

    it('저장한 상태를 같은 트랜잭션 안에서 읽어 돌려준다', async () => {
      await expect(service.reply(3, 7, dto)).resolves.toEqual(saved);
      readInsideTransaction();
    });

    it('없는 문의는 404 이고 아무것도 쓰지 않는다', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(null);
      await expect(service.reply(3, 7, dto)).rejects.toThrow(NotFoundException);
      expect(prisma.inquiry.updateMany).not.toHaveBeenCalled();
    });

    it('그사이 누가 고쳤으면 409 이고 답변 행을 더하지 않고 알리지도 않는다', async () => {
      prisma.inquiry.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reply(3, 7, dto)).rejects.toThrow(ConflictException);
      await settle();
      expect(prisma.inquiryReply.create).not.toHaveBeenCalled();
      expect(ops.notify).not.toHaveBeenCalled();
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it.each(['RECEIVED', 'IN_PROGRESS'])(
      '첫 답변(%s 에서)이면 등록자에게 운영 알림과 메일을 보낸다',
      async (status) => {
        prisma.inquiry.findUnique.mockResolvedValue(inquiry({ status }));
        await service.reply(3, 7, dto);
        await settle();
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

    it('응답은 알림 · 메일을 기다리지 않는다 — SMTP 가 멈춰도 저장 결과는 바로 간다', async () => {
      mail!.send.mockReturnValue(new Promise(() => {}));
      await expect(service.reply(3, 7, dto)).resolves.toEqual(saved);
    });

    it('답변을 고칠 때(이미 답변 완료)는 새 행만 더하고 알리지 않는다(CNT-17)', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(
        inquiry({ status: 'ANSWERED' }),
      );
      await service.reply(3, 7, dto);
      await settle();
      expect(prisma.inquiryReply.create).toHaveBeenCalled();
      expect(ops.notify).not.toHaveBeenCalled();
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('등록자가 사용 중인 계정이 아니면 아무에게도 보내지 않는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await service.reply(3, 7, dto);
      await settle();
      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: [] }),
      );
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('등록자 이메일만 없으면 운영 알림은 가고 메일만 건너뛴다', async () => {
      prisma.adminAccount.findFirst.mockImplementation(
        ({ select }: { select: Record<string, true> }) =>
          Promise.resolve(
            select.email ? { email: null } : { adminAccountId: 21 },
          ),
      );
      await service.reply(3, 7, dto);
      await settle();
      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: [21] }),
      );
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('운영 알림의 받는 사람 조회가 DB 오류여도 메일은 따로 간다', async () => {
      prisma.adminAccount.findFirst.mockImplementation(
        ({ select }: { select: Record<string, true> }) =>
          select.email
            ? Promise.resolve({ email: 'bp@test.invalid' })
            : Promise.reject(new Error('db down')),
      );
      await expect(service.reply(3, 7, dto)).resolves.toEqual(saved);
      await settle();
      expect(mail!.send).toHaveBeenCalled();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('inquiry answered notification FAILED'),
      );
    });

    it('메일이 실패해도 답변 저장은 성공이고, 로그에 오류 메시지(받는 주소가 섞인다)를 남기지 않는다', async () => {
      mail!.send.mockRejectedValue(
        Object.assign(
          new Error('550 5.1.1 <bp@test.invalid> recipient rejected'),
          { code: 'EENVELOPE' },
        ),
      );
      await expect(service.reply(3, 7, dto)).resolves.toEqual(saved);
      await settle();
      const lines = logged.error.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('\n');
      expect(lines).toContain('inquiry answered mail FAILED');
      expect(lines).toContain('code=EENVELOPE');
      expect(lines).not.toContain('bp@test.invalid');
    });

    it('MAIL_* 가 없으면 메일만 건너뛴다', async () => {
      mail = null;
      await build();
      await service.reply(3, 7, dto);
      await settle();
      expect(ops.notify).toHaveBeenCalled();
    });

    it('ADMIN_WEB_URL 이 없으면 메일만 건너뛴다(버튼 링크가 필수다)', async () => {
      adminWebUrl = undefined;
      await build();
      await service.reply(3, 7, dto);
      await settle();
      expect(ops.notify).toHaveBeenCalled();
      expect(mail!.send).not.toHaveBeenCalled();
    });
  });

  describe('saveInternalMemo', () => {
    const dto = {
      internalMemo: '전화 확인함',
      updatedAt: updatedAt.toISOString(),
    };

    it('읽은 뒤 아무도 고치지 않았을 때만 메모를 저장하고, 저장한 상태를 트랜잭션 안에서 읽는다', async () => {
      await expect(service.saveInternalMemo(7, dto)).resolves.toEqual(saved);
      const [{ where, data }] = prisma.inquiry.updateMany.mock.calls[0];
      expect(where).toEqual({
        inquiryId: 7,
        updatedAt: { gte: updatedAt, lt: new Date(updatedAt.getTime() + 1) },
      });
      expect(data).toEqual({ internalMemo: '전화 확인함' });
      readInsideTransaction();
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
