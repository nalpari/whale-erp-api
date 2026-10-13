import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { OpsNotificationService, splitTitle } from './ops-notification.service';

const template = (over: object = {}) => ({
  templateCode: 'NTF_CONTRACT_SIGNED',
  channel: 'NOTIFICATION',
  isActive: true,
  title: '#{직원이름} 님이 근로계약서에 날인했습니다',
  body: '#{근무지}',
  variables: [
    { name: '직원이름', isRequired: true },
    { name: '근무지', isRequired: true },
  ],
  kakaoTemplateCode: null,
  ...over,
});

const input = (over: object = {}) => ({
  templateCode: 'NTF_CONTRACT_SIGNED',
  variables: { 직원이름: '문태경', 근무지: '온기식당 판교점' },
  related: { type: 'CONTRACT' as const, id: 41 },
  eventKey: '900',
  recipients: [10, 11],
  ...over,
});

describe('OpsNotificationService', () => {
  let service: OpsNotificationService;
  let tx: {
    notification: { create: jest.Mock };
    notificationRecipient: {
      createManyAndReturn: jest.Mock<
        Promise<unknown[]>,
        [Prisma.NotificationRecipientCreateManyAndReturnArgs]
      >;
    };
  };
  let prisma: {
    notificationTemplate: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(async () => {
    tx = {
      notification: {
        create: jest.fn().mockResolvedValue({ notificationId: 7 }),
      },
      notificationRecipient: {
        createManyAndReturn: jest
          .fn<
            Promise<unknown[]>,
            [Prisma.NotificationRecipientCreateManyAndReturnArgs]
          >()
          .mockResolvedValue([
            { notificationRecipientId: 70, adminAccountId: 10 },
            { notificationRecipientId: 71, adminAccountId: 11 },
          ]),
      },
    };
    prisma = {
      notificationTemplate: {
        findUnique: jest.fn().mockResolvedValue(template()),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OpsNotificationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(OpsNotificationService);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('템플릿을 채워 알림 한 행과 받는 사람마다 수신 행을 만들고 수신 행을 돌려준다', async () => {
    await expect(service.notify(input())).resolves.toEqual({
      notificationId: 7,
      recipients: [
        { notificationRecipientId: 70, adminAccountId: 10 },
        { notificationRecipientId: 71, adminAccountId: 11 },
      ],
    });
    expect(prisma.notificationTemplate.findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'NTF_CONTRACT_SIGNED' },
    });
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: {
        notificationTarget: 'ADMIN',
        templateCode: 'NTF_CONTRACT_SIGNED',
        relatedType: 'CONTRACT',
        relatedId: 41,
        body: '문태경 님이 근로계약서에 날인했습니다\n온기식당 판교점',
        dedupeKey: 'NTF_CONTRACT_SIGNED:900',
      },
      select: { notificationId: true },
    });
    expect(tx.notificationRecipient.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        { notificationId: 7, adminAccountId: 10 },
        { notificationId: 7, adminAccountId: 11 },
      ],
      select: { notificationRecipientId: true, adminAccountId: true },
    });
  });

  it('같은 관리자가 두 번 들어오면 한 번만 받는다', async () => {
    await service.notify(input({ recipients: [10, 10, 11] }));

    expect(
      tx.notificationRecipient.createManyAndReturn.mock.calls[0][0].data,
    ).toHaveLength(2);
  });

  it('받는 사람이 없으면 만들지 않고 템플릿 코드와 사건 키를 남긴다', async () => {
    await expect(service.notify(input({ recipients: [] }))).resolves.toBeNull();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('template=NTF_CONTRACT_SIGNED event=900'),
    );
  });

  it('같은 사건으로 이미 만들었으면(P2002) 넘어간다', async () => {
    tx.notification.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );

    await expect(service.notify(input())).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it.each<[string, () => unknown, object]>([
    [
      '템플릿이 없음',
      () => prisma.notificationTemplate.findUnique.mockResolvedValue(null),
      {},
    ],
    [
      '템플릿을 사용 안 함',
      () =>
        prisma.notificationTemplate.findUnique.mockResolvedValue(
          template({ isActive: false }),
        ),
      {},
    ],
    [
      '필수 변수가 빠짐',
      () => undefined,
      { variables: { 직원이름: '문태경' } },
    ],
    [
      'DB 오류',
      () => prisma.$transaction.mockRejectedValue(new Error('connection lost')),
      {},
    ],
  ])('%s 이어도 던지지 않고 실패를 남긴다', async (_, arrange, over) => {
    arrange();

    await expect(service.notify(input(over))).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('template=NTF_CONTRACT_SIGNED event=900'),
    );
  });

  it('실패 로그에 변수 값(직원 이름)을 남기지 않는다', async () => {
    tx.notification.create.mockRejectedValue(
      new Prisma.PrismaClientValidationError('문태경 온기식당 판교점', {
        clientVersion: 'x',
      }),
    );

    await service.notify(input());

    const logged = error.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(logged).not.toContain('문태경');
    expect(logged).not.toContain('판교점');
  });
});

describe('splitTitle', () => {
  it('첫 줄을 제목, 나머지를 본문으로 나눈다', () => {
    expect(splitTitle('제목\n둘째 줄')).toEqual({
      title: '제목',
      body: '둘째 줄',
    });
  });

  it('줄바꿈이 없으면 본문은 빈 글이다', () => {
    expect(splitTitle('제목만')).toEqual({ title: '제목만', body: '' });
  });
});
