import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
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
      findMany: jest.Mock;
      count: jest.Mock;
    };
    inquiryReply: { create: jest.Mock; findMany: jest.Mock };
    inquiryAttachment: { findMany: jest.Mock; findFirst: jest.Mock };
    adminAccount: { findFirst: jest.Mock; findMany: jest.Mock };
    bpCode: { findMany: jest.Mock };
    store: { findMany: jest.Mock };
  };
  let ops: { notify: jest.Mock };
  let mail: { send: jest.Mock } | null;
  let storage: { downloadUrl: jest.Mock; thumbnailUrl: jest.Mock } | null;
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
        { provide: STORAGE, useValue: storage },
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
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg)
          ? Promise.all(arg)
          : (arg as (tx: unknown) => unknown)(prisma),
      ),
      inquiry: {
        findUnique: jest.fn().mockResolvedValue(inquiry()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(saved),
        updateMany: (jest.fn() as UpdateMany).mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      inquiryReply: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      inquiryAttachment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          storageKey: 'inquiries/7/0b6f.pdf',
          fileName: '근로계약서 사본.pdf',
        }),
      },
      adminAccount: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ adminAccountId: 21, email: 'bp@test.invalid' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      bpCode: { findMany: jest.fn().mockResolvedValue([]) },
      store: { findMany: jest.fn().mockResolvedValue([]) },
    };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm' }) };
    storage = {
      downloadUrl: jest.fn().mockResolvedValue('https://s3/signed'),
      thumbnailUrl: jest.fn().mockResolvedValue(null),
    };
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
      ['IN_PROGRESS', '이미 처리중인 문의입니다.'],
      ['ANSWERED', '이미 답변한 문의입니다.'],
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
          link: '/support-inquiries/7',
          eventKey: '7',
          recipients: [21],
        });
        expect(mail!.send).toHaveBeenCalledWith({
          templateCode: 'EMAIL_INQUIRY_ANSWERED',
          to: 'bp@test.invalid',
          variables: {
            문의제목: '급여명세서 공제 항목 문의',
            링크: 'https://admin.test.invalid/support-inquiries/7',
          },
          adminAccountId: 21,
        });
        // 시스템이 보내는 답변 알림이라 「대신 발송한 관리자」(sentBy)를 남기지 않는다.
        expect((mail!.send.mock.calls as [object][])[0][0]).not.toHaveProperty(
          'sentBy',
        );
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

  describe('list', () => {
    const row = {
      inquiryId: 7,
      title: '주휴수당이 계산되지 않습니다',
      inquiryCategoryCode: 'STAFF',
      status: 'IN_PROGRESS',
      createdAt: new Date('2026-09-04T01:32:00Z'),
      bpCodeId: 17,
      storeId: 4,
      createdBy: 21,
    };
    const whereOf = () =>
      (prisma.inquiry.findMany.mock.calls[0] as [{ where: unknown }])[0].where;

    beforeEach(() => {
      prisma.inquiry.findMany.mockResolvedValue([row]);
      prisma.inquiry.count.mockResolvedValue(31);
      prisma.bpCode.findMany.mockResolvedValue([
        { bpCodeId: 17, tradeName: '㈜한강상회' },
      ]);
      prisma.store.findMany.mockResolvedValue([
        { storeId: 4, name: '온기식당 광화문점' },
      ]);
      prisma.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: 21, name: '정하윤' },
      ]);
    });

    it('접수 최신순 한 쪽과 같은 조건의 전체 건수, 보낸 곳 이름을 준다', async () => {
      const result = await service.list({ page: 2, pageSize: 10 });
      expect(prisma.inquiry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          orderBy: [{ createdAt: 'desc' }, { inquiryId: 'desc' }],
          skip: 10,
          take: 10,
        }),
      );
      expect(prisma.inquiry.count).toHaveBeenCalledWith({ where: {} });
      expect(result).toEqual({
        total: 31,
        items: [
          {
            inquiryId: 7,
            title: '주휴수당이 계산되지 않습니다',
            inquiryCategoryCode: 'STAFF',
            status: 'IN_PROGRESS',
            createdAt: row.createdAt,
            bpName: '㈜한강상회',
            storeName: '온기식당 광화문점',
            senderName: '정하윤',
          },
        ],
      });
    });

    it('점포 대상이 아니거나 이름을 찾을 수 없으면 null', async () => {
      prisma.inquiry.findMany.mockResolvedValue([{ ...row, storeId: null }]);
      prisma.bpCode.findMany.mockResolvedValue([]);
      prisma.adminAccount.findMany.mockResolvedValue([]);
      const { items } = await service.list({ page: 1, pageSize: 20 });
      expect(items[0]).toMatchObject({
        bpName: null,
        storeName: null,
        senderName: null,
      });
    });

    it.each([
      [['WAITING'], ['RECEIVED', 'IN_PROGRESS']],
      [['ANSWERED'], ['ANSWERED']],
      [
        ['WAITING', 'ANSWERED'],
        ['RECEIVED', 'IN_PROGRESS', 'ANSWERED'],
      ],
    ] as const)('%j 는 상태 %j 로 거른다', async (answerStatus, statuses) => {
      await service.list({
        answerStatus: [...answerStatus],
        page: 1,
        pageSize: 20,
      });
      expect(whereOf()).toEqual({ status: { in: statuses } });
    });

    it('제목은 대소문자 없이 들어 있는 것으로 거른다', async () => {
      await service.list({ title: 'kiosk', page: 1, pageSize: 20 });
      expect(whereOf()).toEqual({
        title: { contains: 'kiosk', mode: 'insensitive' },
      });
    });

    // Prisma 의 contains 는 LIKE 와일드카드를 이스케이프하지 않는다(공용 DB 에서 `_` 가 BP 9 곳 모두에 맞음). 글자 그대로 찾는다.
    it('검색어의 % · _ · \\ 는 글자 그대로 찾는다', async () => {
      await service.list({
        title: '50%_off\\',
        sender: '_',
        page: 1,
        pageSize: 20,
      });
      expect(whereOf()).toMatchObject({
        title: { contains: '50\\%\\_off\\\\', mode: 'insensitive' },
      });
      const name = { contains: '\\_', mode: 'insensitive' };
      expect(prisma.bpCode.findMany).toHaveBeenCalledWith({
        where: { tradeName: name },
        select: { bpCodeId: true },
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { name },
        select: { storeId: true },
      });
    });

    it('보낸 곳은 BP 이름 · 점포 이름 · 보낸 사람 이름 중 하나에 맞으면 나온다', async () => {
      prisma.bpCode.findMany.mockResolvedValueOnce([{ bpCodeId: 17 }]);
      prisma.store.findMany.mockResolvedValueOnce([{ storeId: 4 }]);
      prisma.adminAccount.findMany.mockResolvedValueOnce([
        { adminAccountId: 21 },
      ]);
      await service.list({ sender: '한강', page: 1, pageSize: 20 });
      const name = { contains: '한강', mode: 'insensitive' };
      expect(prisma.bpCode.findMany).toHaveBeenCalledWith({
        where: { tradeName: name },
        select: { bpCodeId: true },
      });
      expect(prisma.store.findMany).toHaveBeenCalledWith({
        where: { name },
        select: { storeId: true },
      });
      expect(prisma.adminAccount.findMany).toHaveBeenCalledWith({
        where: { name },
        select: { adminAccountId: true },
      });
      expect(whereOf()).toEqual({
        OR: [
          { bpCodeId: { in: [17] } },
          { storeId: { in: [4] } },
          { createdBy: { in: [21] } },
        ],
      });
      // total 은 한 쪽과 같은 조건으로 센다 — 갈라지면 다른 집합을 센다.
      expect(prisma.inquiry.count).toHaveBeenCalledWith({ where: whereOf() });
    });

    it('조건을 함께 주면 모두 AND 로 건다', async () => {
      prisma.bpCode.findMany.mockResolvedValueOnce([{ bpCodeId: 17 }]);
      prisma.store.findMany.mockResolvedValueOnce([]);
      prisma.adminAccount.findMany.mockResolvedValueOnce([]);
      await service.list({
        answerStatus: ['ANSWERED'],
        title: 'kiosk',
        sender: '한강',
        page: 1,
        pageSize: 20,
      });
      expect(whereOf()).toEqual({
        status: { in: ['ANSWERED'] },
        title: { contains: 'kiosk', mode: 'insensitive' },
        OR: [
          { bpCodeId: { in: [17] } },
          { storeId: { in: [] } },
          { createdBy: { in: [] } },
        ],
      });
      expect(prisma.inquiry.count).toHaveBeenCalledWith({ where: whereOf() });
    });

    it('마지막 쪽을 넘기면 빈 목록과 전체 건수다', async () => {
      prisma.inquiry.findMany.mockResolvedValue([]);
      prisma.inquiry.count.mockResolvedValue(3);
      await expect(service.list({ page: 99, pageSize: 20 })).resolves.toEqual({
        items: [],
        total: 3,
      });
    });
  });

  describe('get', () => {
    const found = {
      inquiryId: 7,
      title: '주휴수당이 계산되지 않습니다',
      body: '0원으로 나옵니다',
      inquiryCategoryCode: 'STAFF',
      status: 'ANSWERED',
      createdAt: new Date('2026-09-04T01:32:00Z'),
      updatedAt,
      bpCodeId: 17,
      storeId: null,
      createdBy: 21,
      processingStartedBy: 3,
      processingStartedAt: new Date('2026-09-04T02:15:00Z'),
      internalMemo: '계약 확인',
    };
    const replies = [
      {
        inquiryReplyId: 1,
        body: '첫 답변',
        repliedAt: new Date('2026-09-04T03:00:00Z'),
        repliedBy: 3,
      },
      {
        inquiryReplyId: 2,
        body: '고친 답변',
        repliedAt: new Date('2026-09-05T03:00:00Z'),
        repliedBy: 4,
      },
    ];
    const attachments = [
      {
        inquiryAttachmentId: 9,
        fileName: '9월_급여명세서.pdf',
        fileType: 'PDF',
        sizeBytes: 1_200_000,
        storageKey: 'inquiries/7/0b6f.pdf',
      },
    ];

    beforeEach(() => {
      prisma.inquiry.findUnique.mockResolvedValue(found);
      prisma.inquiryReply.findMany.mockResolvedValue(replies);
      prisma.inquiryAttachment.findMany.mockResolvedValue(attachments);
      prisma.bpCode.findMany.mockResolvedValue([
        { bpCodeId: 17, tradeName: '㈜한강상회' },
      ]);
      prisma.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: 21, name: '정하윤', roleTypeCode: 'BM' },
        { adminAccountId: 3, name: '이서준', roleTypeCode: 'PA' },
        { adminAccountId: 4, name: '김지영', roleTypeCode: 'PM' },
      ]);
    });

    it('답변 이력 · 첨부파일 · 처리 이력과 사람 이름을 함께 준다', async () => {
      const result = await service.get(7);
      expect(prisma.inquiry.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { inquiryId: 7 } }),
      );
      expect(result).toEqual({
        inquiryId: 7,
        title: found.title,
        body: found.body,
        inquiryCategoryCode: 'STAFF',
        status: 'ANSWERED',
        createdAt: found.createdAt,
        updatedAt,
        bpName: '㈜한강상회',
        storeName: null,
        createdBy: 21,
        senderName: '정하윤',
        senderRoleTypeCode: 'BM',
        processingStartedAt: found.processingStartedAt,
        processingStartedBy: 3,
        processingStartedByName: '이서준',
        internalMemo: '계약 확인',
        replies: [
          { ...replies[0], repliedByName: '이서준' },
          { ...replies[1], repliedByName: '김지영' },
        ],
        // 저장 키는 내보내지 않는다. 썸네일 주소는 저장소가 준 값 그대로다(PDF 판정은 StorageService 몫).
        attachments: [
          {
            inquiryAttachmentId: 9,
            fileName: '9월_급여명세서.pdf',
            fileType: 'PDF',
            sizeBytes: 1_200_000,
            thumbnailUrl: null,
          },
        ],
      });
      // 점포 대상이 아니면 점포는 묻지 않는다.
      expect(prisma.store.findMany).not.toHaveBeenCalled();
    });

    it('답변은 오래된 것부터, 첨부파일은 순서대로 읽는다', async () => {
      await service.get(7);
      expect(prisma.inquiryReply.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { inquiryId: 7 },
          orderBy: [{ repliedAt: 'asc' }, { inquiryReplyId: 'asc' }],
        }),
      );
      expect(prisma.inquiryAttachment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { inquiryId: 7 },
          orderBy: { sortOrder: 'asc' },
        }),
      );
    });

    it('점포 대상 문의면 점포 이름을 준다', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({ ...found, storeId: 4 });
      prisma.store.findMany.mockResolvedValue([
        { storeId: 4, name: '온기식당 광화문점' },
      ]);
      await expect(service.get(7)).resolves.toMatchObject({
        storeName: '온기식당 광화문점',
      });
    });

    // 테이블에 칸이 더해져도 응답에 저절로 실리지 않는다 — 내보낼 칸은 DTO 에 적은 것뿐이다.
    it('행에 다른 칸이 있어도 응답에 싣지 않는다', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({
        ...found,
        futureColumn: 'x',
      });
      await expect(service.get(7)).resolves.not.toHaveProperty('futureColumn');
    });

    it('없으면 404', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(null);
      await expect(service.get(7)).rejects.toThrow(NotFoundException);
    });

    it('이미지 첨부는 작은 미리보기 주소를 싣는다(#277)', async () => {
      prisma.inquiryAttachment.findMany.mockResolvedValue([
        { ...attachments[0], fileType: 'PNG', storageKey: 'inquiries/7/a.png' },
      ]);
      storage!.thumbnailUrl.mockResolvedValue('https://s3/thumb');
      const result = await service.get(7);
      expect(result.attachments).toEqual([
        expect.objectContaining({ thumbnailUrl: 'https://s3/thumb' }),
      ]);
      expect(storage!.thumbnailUrl).toHaveBeenCalledWith('inquiries/7/a.png');
    });

    it('저장소 설정이 없어도 상세는 보이고 미리보기 주소만 null', async () => {
      storage = null;
      await build();
      await expect(service.get(7)).resolves.toMatchObject({
        attachments: [expect.objectContaining({ thumbnailUrl: null })],
      });
    });
  });

  describe('attachmentDownloadUrl', () => {
    it('그 문의의 첨부를 원래 파일 이름으로 받는 서명 주소를 준다', async () => {
      await expect(service.attachmentDownloadUrl(7, 3)).resolves.toEqual({
        url: 'https://s3/signed',
      });
      // 다른 문의의 첨부 ID 를 붙여 받지 못하게 문의 ID 도 조건에 넣는다.
      expect(prisma.inquiryAttachment.findFirst).toHaveBeenCalledWith({
        where: { inquiryAttachmentId: 3, inquiryId: 7 },
        select: { storageKey: true, fileName: true },
      });
      expect(storage!.downloadUrl).toHaveBeenCalledWith(
        'inquiries/7/0b6f.pdf',
        '근로계약서 사본.pdf',
      );
    });

    it('그 문의의 첨부가 아니면 404', async () => {
      prisma.inquiryAttachment.findFirst.mockResolvedValue(null);
      await expect(service.attachmentDownloadUrl(7, 3)).rejects.toThrow(
        NotFoundException,
      );
      expect(storage!.downloadUrl).not.toHaveBeenCalled();
    });

    it('저장소 설정이 없으면 DB 에 묻지 않고 503', async () => {
      storage = null;
      await build();
      await expect(service.attachmentDownloadUrl(7, 3)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.inquiryAttachment.findFirst).not.toHaveBeenCalled();
    });
  });
});
