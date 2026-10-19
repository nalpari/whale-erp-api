import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { SupportInquiriesService } from './support-inquiries.service';

// 알림은 응답을 기다리게 하지 않고 뒤에서 보낸다. 그 일이 끝날 때까지 기다린다.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 규칙의 경계만 목으로 본다. 같은 문의를 동시에 두 번 올려도 하나만 들어가는지는 실제 PostgreSQL 에서 도는
// e2e 만 증명한다 — PGlite 소켓 서버는 연결을 차례로 처리해 잠금이 없어도 통과한다.
describe('SupportInquiriesService', () => {
  let service: SupportInquiriesService;
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    adminAccount: { findFirst: jest.Mock; findMany: jest.Mock };
    codeItem: { count: jest.Mock };
    bpCode: { findUnique: jest.Mock };
    store: { findUnique: jest.Mock };
    inquiry: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    inquiryReply: { findMany: jest.Mock; groupBy: jest.Mock };
    inquiryAttachment: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
  };
  let scope: { listStores: jest.Mock };
  let ops: { notify: jest.Mock };
  let storage: {
    put: jest.Mock;
    delete: jest.Mock;
    downloadUrl: jest.Mock;
    thumbnailUrl: jest.Mock;
  } | null;

  const dto = {
    inquiryCategoryCode: 'STAFF_LABOR',
    title: '주휴수당이 계산되지 않습니다',
    body: '파트타이머 주휴수당이 0원으로 나옵니다.',
  };
  const file = (name: string, fileType: 'PNG' | 'PDF' = 'PNG') => ({
    fileName: name,
    buffer: Buffer.from(name),
    fileType,
    sizeBytes: name.length,
  });

  let logged: { error: jest.SpyInstance; warn: jest.SpyInstance };

  const createdWith = () =>
    (prisma.inquiry.create.mock.calls as [[{ data: unknown }]])[0][0];

  async function build() {
    const module = await Test.createTestingModule({
      providers: [
        SupportInquiriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: OpsNotificationService, useValue: ops },
        { provide: STORAGE, useValue: storage },
      ],
    }).compile();
    service = module.get(SupportInquiriesService);
    logged = {
      error: jest.spyOn(service['logger'], 'error').mockImplementation(),
      warn: jest.spyOn(service['logger'], 'warn').mockImplementation(),
    };
  }

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg)
          ? Promise.all(arg)
          : (arg as (tx: unknown) => unknown)(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(1),
      adminAccount: {
        // 등록한 관리자. 플랫폼 운영자 조회(findMany)와 구분한다.
        findFirst: jest
          .fn()
          .mockResolvedValue({ bpCodeId: 3, roleTypeCode: 'BM' }),
        findMany: jest.fn().mockResolvedValue([{ adminAccountId: 1 }]),
      },
      codeItem: { count: jest.fn().mockResolvedValue(1) },
      bpCode: {
        findUnique: jest.fn().mockResolvedValue({ tradeName: '모리커피' }),
      },
      store: { findUnique: jest.fn().mockResolvedValue({ name: '연남점' }) },
      inquiry: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ inquiryId: 7 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      inquiryReply: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      inquiryAttachment: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    scope = { listStores: jest.fn().mockResolvedValue([]) };
    ops = { notify: jest.fn().mockResolvedValue(undefined) };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      downloadUrl: jest.fn().mockResolvedValue('https://signed'),
      thumbnailUrl: jest.fn().mockResolvedValue('https://signed-thumb'),
    };
    await build();
  });

  describe('create', () => {
    it('BP 관리자의 문의는 소속 BP 로, 대상 점포는 비워 저장한다', async () => {
      await expect(service.create(21, dto, [])).resolves.toEqual({
        inquiryId: 7,
      });
      expect(prisma.inquiry.create).toHaveBeenCalledWith({
        data: { ...dto, createdBy: 21, bpCodeId: 3, storeId: null },
        select: { inquiryId: true },
      });
      expect(scope.listStores).not.toHaveBeenCalled();
    });

    it('점포 단위 관리자(가맹)는 관리하는 점포 하나를 대상 점포로 채운다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        roleTypeCode: 'FA',
      });
      scope.listStores.mockResolvedValue([{ storeId: 11 }]);
      await service.create(21, dto, []);
      expect(createdWith()).toMatchObject({
        data: { storeId: 11 },
      });
    });

    it.each([[[]], [[{ storeId: 11 }, { storeId: 12 }]]])(
      '점포 단위 관리자의 관리 점포가 하나가 아니면(%j) 비워 BP 단위 문의로 둔다(2026-10-19 재영)',
      async (stores: { storeId: number }[]) => {
        prisma.adminAccount.findFirst.mockResolvedValue({
          bpCodeId: 3,
          roleTypeCode: 'FM',
        });
        scope.listStores.mockResolvedValue(stores);
        await service.create(21, dto, []);
        expect(createdWith()).toMatchObject({
          data: { storeId: null },
        });
      },
    );

    it('사용 중인 관리자 계정이 아니면 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.create(21, dto, [])).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
    });

    it('사용 중인 문의 유형이 아니면 400 이고 저장하지 않는다', async () => {
      prisma.codeItem.count.mockResolvedValue(0);
      await expect(service.create(21, dto, [])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.codeItem.count).toHaveBeenCalledWith({
        where: {
          groupCode: 'INQUIRY_CATEGORY',
          itemCode: 'STAFF_LABOR',
          bpCode: 'BP000000',
          status: 'ACTIVE',
          isDeleted: false,
        },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('같은 관리자가 5분 안에 제목 · 내용이 같은 문의를 다시 올리면 잠근 뒤 확인해 409', async () => {
      const before = Date.now();
      prisma.inquiry.findFirst.mockResolvedValue({ inquiryId: 6 });
      await expect(service.create(21, dto, [])).rejects.toBeInstanceOf(
        ConflictException,
      );
      // 잠금은 관리자 단위다 — 다른 관리자의 등록은 줄을 서지 않는다.
      expect(
        (prisma.$executeRaw.mock.calls as unknown[][])[0].slice(1),
      ).toEqual(['inquiries:created_by:21']);
      const [{ where }] = prisma.inquiry.findFirst.mock.calls[0] as [
        { where: { createdAt: { gt: Date } } & Record<string, unknown> },
      ];
      expect(where).toMatchObject({
        createdBy: 21,
        title: dto.title,
        body: dto.body,
      });
      const fiveMinutes = 5 * 60 * 1000;
      const gt = where.createdAt.gt.getTime();
      expect(gt).toBeGreaterThanOrEqual(before - fiveMinutes);
      expect(gt).toBeLessThanOrEqual(Date.now() - fiveMinutes);
      expect(prisma.inquiry.create).not.toHaveBeenCalled();
      await settle();
      expect(ops.notify).not.toHaveBeenCalled();
    });

    it('등록하면 플랫폼 운영자에게 운영 알림을 보낸다 — 문의자는 BP · 점포 이름', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        bpCodeId: 3,
        roleTypeCode: 'FA',
      });
      scope.listStores.mockResolvedValue([{ storeId: 11 }]);
      await service.create(21, dto, []);
      await settle();
      expect(ops.notify).toHaveBeenCalledWith({
        templateCode: 'NTF_INQUIRY_RECEIVED',
        variables: { 문의자: '모리커피 연남점', 문의제목: dto.title },
        related: { type: 'INQUIRY', id: 7 },
        link: '/platform/community/inquiries/7',
        eventKey: '7',
        recipients: [1],
      });
    });

    it('BP 단위 문의의 문의자는 BP 이름뿐이다', async () => {
      await service.create(21, dto, []);
      await settle();
      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { 문의자: '모리커피', 문의제목: dto.title },
        }),
      );
    });

    it.each([
      ['알림', () => ops.notify.mockRejectedValue(new Error('down'))],
      [
        '받는 사람 조회',
        () => prisma.adminAccount.findMany.mockRejectedValue(new Error('db')),
      ],
    ])('%s 이 실패해도 등록은 성공이고 오류로 남긴다', async (_, fail) => {
      fail();
      await expect(service.create(21, dto, [])).resolves.toEqual({
        inquiryId: 7,
      });
      await settle();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'inquiry received notification FAILED inquiry=7',
        ),
      );
    });

    it('첨부를 저장소에 올리고 순서대로 행을 만든다', async () => {
      await service.create(21, dto, [file('a.png'), file('b.pdf', 'PDF')]);
      const keys = storage!.put.mock.calls.map((c: unknown[]) => c[0]);
      expect(keys).toEqual([
        expect.stringMatching(/^inquiries\/7\/[0-9a-f-]+\.png$/),
        expect.stringMatching(/^inquiries\/7\/[0-9a-f-]+\.pdf$/),
      ]);
      // 이미지는 상세의 작은 미리보기(CNT-18)를 위해 썸네일도 만든다 — PDF 는 저장소가 건너뛴다.
      expect(storage!.put).toHaveBeenCalledWith(
        keys[0],
        expect.any(Buffer),
        'PNG',
        { thumbnail: true },
      );
      expect(prisma.inquiryAttachment.createMany).toHaveBeenCalledWith({
        data: [
          {
            inquiryId: 7,
            fileName: 'a.png',
            fileType: 'PNG',
            sizeBytes: 5,
            storageKey: keys[0],
            sortOrder: 1,
          },
          {
            inquiryId: 7,
            fileName: 'b.pdf',
            fileType: 'PDF',
            sizeBytes: 5,
            storageKey: keys[1],
            sortOrder: 2,
          },
        ],
      });
    });

    it('첨부 없이는 저장소를 부르지 않는다', async () => {
      await service.create(21, dto, []);
      expect(storage!.put).not.toHaveBeenCalled();
      expect(prisma.inquiryAttachment.createMany).not.toHaveBeenCalled();
    });

    it('저장소 설정이 없어도 첨부 없는 문의는 등록된다', async () => {
      storage = null;
      await build();
      await expect(service.create(21, dto, [])).resolves.toEqual({
        inquiryId: 7,
      });
    });

    it('첨부가 있는데 저장소 설정이 없으면 503', async () => {
      storage = null;
      await build();
      await expect(
        service.create(21, dto, [file('a.png')]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('문의 유형도 틀리고 저장소도 없으면 400 이 먼저다', async () => {
      storage = null;
      await build();
      prisma.codeItem.count.mockResolvedValue(0);
      await expect(
        service.create(21, dto, [file('a.png')]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('업로드 뒤 첨부 행 저장이 실패해도 올린 파일을 모두 지운다', async () => {
      prisma.inquiryAttachment.createMany.mockRejectedValue(new Error('db'));
      await expect(
        service.create(21, dto, [file('a.png'), file('b.png')]),
      ).rejects.toThrow('db');
      const keys = storage!.put.mock.calls.map((c: unknown[]) => c[0]);
      // 썸네일과 함께 올렸으니 썸네일까지 지운다 — 썸네일을 건너뛰는 옵션으로 부르지 않는다.
      expect(storage!.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(
        keys,
      );
      expect(storage!.delete).not.toHaveBeenCalledWith(expect.anything(), {
        thumbnail: false,
      });
    });

    it('썸네일을 만들 수 없는 이미지(깨짐 · 화소 초과)는 400 그대로이고 올린 파일을 지운다', async () => {
      storage!.put.mockRejectedValueOnce(
        new BadRequestException('이미지를 읽을 수 없습니다'),
      );
      await expect(
        service.create(21, dto, [file('a.png')]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage!.delete).toHaveBeenCalledTimes(1);
      expect(logged.error).not.toHaveBeenCalled();
    });

    it('여러 파일 중 하나만 썸네일을 못 만들어도 모두 끝난 뒤 400 이고 모두 지운다', async () => {
      storage!.put.mockRejectedValueOnce(
        new BadRequestException('이미지를 읽을 수 없습니다'),
      );
      await expect(
        service.create(21, dto, [file('a.png'), file('b.png')]),
      ).rejects.toBeInstanceOf(BadRequestException);
      const keys = storage!.put.mock.calls.map((c: unknown[]) => c[0]);
      expect(storage!.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(
        keys,
      );
      expect(logged.error).not.toHaveBeenCalled();
    });

    it('깨진 이미지(400)와 저장소 장애가 섞이면 503 이고 장애를 로그로 남긴다', async () => {
      storage!.put
        .mockRejectedValueOnce(
          new BadRequestException('이미지를 읽을 수 없습니다'),
        )
        .mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(
        service.create(21, dto, [file('a.png'), file('b.png')]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('문의 첨부 올리기 실패 inquiry=7 1/2건'),
        expect.stringContaining('AccessDenied'),
      );
    });

    it('정리가 실패해도 원래 오류가 나가고, 정리 실패는 error 로 남긴다', async () => {
      storage!.put.mockRejectedValue(new Error('s3 down'));
      storage!.delete.mockRejectedValue(new Error('still down'));
      await expect(
        service.create(21, dto, [file('a.png')]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringMatching(/문의 첨부 정리 실패 admin=21 inquiries\/7\//),
        expect.stringContaining('still down'),
      );
    });

    it('한 파일이 먼저 실패해도 나머지 업로드가 끝난 뒤에 지운다', async () => {
      let finishSecond!: () => void;
      storage!.put
        .mockRejectedValueOnce(new Error('s3 down'))
        .mockImplementationOnce(
          () => new Promise<void>((resolve) => (finishSecond = resolve)),
        );
      const result = service.create(21, dto, [file('a.png'), file('b.png')]);
      await settle();
      // 아직 올리는 중인 파일이 있으면 지우지 않는다 — 지운 뒤에 그 업로드가 끝나면 파일이 남는다.
      expect(storage!.delete).not.toHaveBeenCalled();
      finishSecond();
      await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(storage!.delete).toHaveBeenCalledTimes(2);
    });

    it('트랜잭션 시간 초과(잠금 대기 · 느린 업로드)는 503 — 다시 시도할 일이다', async () => {
      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('timeout', {
          code: 'P2028',
          clientVersion: '7',
        }),
      );
      await expect(service.create(21, dto, [])).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('올리기가 실패하면 503 이고 올린 파일을 지운다', async () => {
      storage!.put
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('s3 down'));
      await expect(
        service.create(21, dto, [file('a.png'), file('b.png')]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      const keys = storage!.put.mock.calls.map((c: unknown[]) => c[0]);
      expect(storage!.delete.mock.calls.map((c: unknown[]) => c[0])).toEqual(
        expect.arrayContaining(keys),
      );
      await settle();
      expect(ops.notify).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('본인이 등록한 문의만 최신순으로, 처음 답변한 시각과 함께 준다', async () => {
      const createdAt = new Date('2026-09-04T01:00:00Z');
      const repliedAt = new Date('2026-09-05T01:00:00Z');
      prisma.inquiry.findMany.mockResolvedValue([
        {
          inquiryId: 7,
          title: 't',
          inquiryCategoryCode: 'ETC',
          status: 'ANSWERED',
          createdAt,
        },
        {
          inquiryId: 6,
          title: 'u',
          inquiryCategoryCode: 'ETC',
          status: 'RECEIVED',
          createdAt,
        },
      ]);
      prisma.inquiry.count.mockResolvedValue(2);
      prisma.inquiryReply.groupBy.mockResolvedValue([
        { inquiryId: 7, _min: { repliedAt } },
      ]);

      const result = await service.list(21, {
        status: 'ANSWERED',
        title: '주휴',
        page: 2,
        pageSize: 10,
      });

      const where = {
        createdBy: 21,
        status: 'ANSWERED',
        title: { contains: '주휴', mode: 'insensitive' },
      };
      expect(prisma.inquiry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: [{ createdAt: 'desc' }, { inquiryId: 'desc' }],
          skip: 10,
          take: 10,
        }),
      );
      expect(prisma.inquiry.count).toHaveBeenCalledWith({ where });
      expect(result).toEqual({
        total: 2,
        items: [
          expect.objectContaining({ inquiryId: 7, repliedAt }),
          expect.objectContaining({ inquiryId: 6, repliedAt: null }),
        ],
      });
    });
  });

  describe('get', () => {
    const row = {
      inquiryId: 7,
      title: 't',
      inquiryCategoryCode: 'ETC',
      status: 'ANSWERED',
      createdAt: new Date('2026-08-30T07:12:00Z'),
      body: 'b',
      processingStartedAt: new Date('2026-08-31T00:12:00Z'),
    };

    it('남의 문의는 없는 문의처럼 404', async () => {
      prisma.inquiry.findFirst.mockResolvedValue(null);
      await expect(service.get(21, 7)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.inquiry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { inquiryId: 7, createdBy: 21 } }),
      );
    });

    it('답변이 없으면 reply 는 null', async () => {
      prisma.inquiry.findFirst.mockResolvedValue(row);
      await expect(service.get(21, 7)).resolves.toMatchObject({
        reply: null,
        repliedAt: null,
      });
    });

    it('고친 답변은 마지막 내용 · 처음 시각 · 수정 시각만 준다 — 운영자는 싣지 않는다', async () => {
      const first = new Date('2026-08-31T00:40:00Z');
      const last = new Date('2026-09-02T02:05:00Z');
      prisma.inquiry.findFirst.mockResolvedValue(row);
      prisma.inquiryReply.findMany.mockResolvedValue([
        { body: '처음', repliedAt: first },
        { body: '고침', repliedAt: last },
      ]);
      prisma.inquiryAttachment.findMany.mockResolvedValue([
        {
          inquiryAttachmentId: 1,
          fileName: 'a.png',
          fileType: 'PNG',
          sizeBytes: 9,
          storageKey: 'inquiries/7/a.png',
        },
      ]);
      const result = await service.get(21, 7);
      // 저장 키는 내보내지 않고, 작은 미리보기 주소(#284)를 싣는다.
      expect(result).toEqual({
        ...row,
        repliedAt: first,
        reply: { body: '고침', repliedAt: first, editedAt: last },
        attachments: [
          {
            inquiryAttachmentId: 1,
            fileName: 'a.png',
            fileType: 'PNG',
            sizeBytes: 9,
            thumbnailUrl: 'https://signed-thumb',
          },
        ],
      });
      expect(storage!.thumbnailUrl).toHaveBeenCalledWith('inquiries/7/a.png');
      expect(prisma.inquiryReply.findMany).toHaveBeenCalledWith({
        where: { inquiryId: 7 },
        select: { body: true, repliedAt: true },
        orderBy: [{ repliedAt: 'asc' }, { inquiryReplyId: 'asc' }],
      });
    });

    it('한 번만 답변했으면 editedAt 은 null', async () => {
      const first = new Date('2026-08-31T00:40:00Z');
      prisma.inquiry.findFirst.mockResolvedValue(row);
      prisma.inquiryReply.findMany.mockResolvedValue([
        { body: '처음', repliedAt: first },
      ]);
      await expect(service.get(21, 7)).resolves.toMatchObject({
        reply: { body: '처음', repliedAt: first, editedAt: null },
      });
    });
  });

  describe('attachmentDownloadUrl', () => {
    it('본인 문의의 첨부만 준다 — 아니면 404', async () => {
      await expect(
        service.attachmentDownloadUrl(21, 7, 1),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.inquiryAttachment.findFirst).toHaveBeenCalledWith({
        where: {
          inquiryAttachmentId: 1,
          inquiryId: 7,
          inquiry: { createdBy: 21 },
        },
        select: { storageKey: true, fileName: true },
      });
    });

    it('서명 주소를 준다', async () => {
      prisma.inquiryAttachment.findFirst.mockResolvedValue({
        storageKey: 'inquiries/7/x.png',
        fileName: 'a.png',
      });
      await expect(service.attachmentDownloadUrl(21, 7, 1)).resolves.toEqual({
        url: 'https://signed',
      });
      expect(storage!.downloadUrl).toHaveBeenCalledWith(
        'inquiries/7/x.png',
        'a.png',
      );
    });
  });
});
