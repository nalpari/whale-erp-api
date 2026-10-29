import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
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
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: UpdateMany;
      findMany: jest.Mock;
      count: jest.Mock;
      deleteMany: jest.Mock;
    };
    adminAccount: { findMany: jest.Mock };
    codeItem: { findFirst: jest.Mock };
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    notificationDelivery: { deleteMany: jest.Mock };
    notificationRecipient: { deleteMany: jest.Mock };
    notification: { deleteMany: jest.Mock };
  };
  let ops: { notify: jest.Mock };
  let mail: { send: jest.Mock } | null;
  let logged: {
    error: jest.SpyInstance;
    log: jest.SpyInstance;
    warn: jest.SpyInstance;
  };
  // 저장한 트랜잭션 안에서 읽은 상태. 트랜잭션 밖 읽기(findUnique)와 다른 값이라 어느 쪽을 돌려줬는지 가린다.
  const saved = {
    leadId: 5,
    status: 'ANSWERED',
    updatedAt: new Date('2026-10-14T01:05:00.000Z'),
  };

  const updatedAt = new Date('2026-10-14T01:02:03.456Z');
  // 답변 메일 시각 — DB 시계로 잡혀 돌아온다(#597).
  const mailedAt = new Date('2026-10-14T01:10:00.123Z');
  let claimed: Record<string, unknown>[];
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
    claimed = [
      {
        email: 'doyun@example.com',
        reply: '다음 주에 방문 상담드리겠습니다',
        attemptedAt: mailedAt,
      },
    ];
    jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
    prisma = {
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg)
          ? Promise.all(arg)
          : (arg as (tx: unknown) => unknown)(prisma),
      ),
      lead: {
        findUnique: jest.fn().mockResolvedValue(lead()),
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue(saved),
        updateMany: (jest.fn() as UpdateMany).mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminAccountId: 1 }, { adminAccountId: 2 }]),
      },
      codeItem: { findFirst: jest.fn().mockResolvedValue({ label: '카페' }) },
      // 알림을 만든 뒤 도입문의가 아직 있는지 다시 본다(#590). 기본은 있다.
      // 답변 메일 시각을 잡는 UPDATE … RETURNING 도 $queryRaw 다(#597). 기본은 잡힌다.
      $queryRaw: jest.fn((sql: TemplateStringsArray) =>
        Promise.resolve(
          sql.join('?').includes('reply_mail_attempted_at')
            ? claimed
            : [{ leadId: 5 }],
        ),
      ),
      // 답변 메일 결과를 남기는 UPDATE(#597)
      $executeRaw: jest.fn().mockResolvedValue(1),
      notificationDelivery: { deleteMany: jest.fn() },
      notificationRecipient: { deleteMany: jest.fn() },
      notification: { deleteMany: jest.fn() },
    };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm' }) };
    await build();
  });

  const build = async () => {
    const module = await Test.createTestingModule({
      providers: [
        LeadsAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpsNotificationService, useValue: ops },
        { provide: OPTIONAL_MAIL_SERVICE, useValue: mail },
      ],
    }).compile();
    service = module.get(LeadsAdminService);
    logged = {
      error: jest.spyOn(service['logger'], 'error').mockImplementation(),
      log: jest.spyOn(service['logger'], 'log').mockImplementation(),
      warn: jest.spyOn(service['logger'], 'warn').mockImplementation(),
    };
  };

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
        new ConflictException('이미 답변한 도입문의입니다.'),
      );
      prisma.lead.findUnique.mockResolvedValue(lead({ status: 'IN_PROGRESS' }));
      await expect(service.startProcessing(3, 5)).rejects.toThrow(
        new ConflictException('이미 처리중인 도입문의입니다.'),
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

    it('읽은 뒤 그사이 지워졌으면 409 가 아니라 404', async () => {
      prisma.lead.findUnique
        .mockResolvedValueOnce(lead())
        .mockResolvedValueOnce(null);
      prisma.lead.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.reply(3, 5, { reply: 'x', updatedAt: updatedAt.toISOString() }),
      ).rejects.toThrow(NotFoundException);
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
      link: '/platform-leads/5',
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

    // 알림이 도입문의를 읽은 뒤 지우기(#590)가 커밋되면, 지운 뒤에 이름이 든 알림이 생긴다.
    it('알림을 만든 사이 도입문의가 지워졌으면 그 알림을 지운다', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await service.startProcessing(3, 5);
      await settle();
      expect(ops.notify).toHaveBeenCalled();
      expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { relatedType: 'LEAD', relatedId: { in: [5] } },
      });
      expect(
        Math.min(...prisma.notification.deleteMany.mock.invocationCallOrder),
      ).toBeGreaterThan(Math.max(...ops.notify.mock.invocationCallOrder));
    });

    // 정리 실패는 「알림 실패」가 아니라 개인정보가 남은 것이다 — 사람이 지워야 한다는 신호로 남긴다.
    it('지워진 도입문의의 알림을 치우지 못하면 CLEANUP FAILED 로 남긴다', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.notification.deleteMany.mockRejectedValue(new Error('db down'));
      await expect(service.startProcessing(3, 5)).resolves.toEqual(saved);
      await settle();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /lead status notification FAILED lead=5 .*CLEANUP FAILED/,
        ),
      );
    });

    it('도입문의가 남아 있으면 알림을 지우지 않는다', async () => {
      await service.startProcessing(3, 5);
      await settle();
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
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

  describe('답변 메일 (#588)', () => {
    const dto = {
      reply: '다음 주에 방문 상담드리겠습니다',
      updatedAt: updatedAt.toISOString(),
    };
    beforeEach(() =>
      prisma.lead.findUnique.mockResolvedValue(
        lead({ email: 'doyun@example.com', internalMemo: '내부 메모' }),
      ),
    );

    it.each(['RECEIVED', 'IN_PROGRESS'])(
      '%s 에서 처음 답변하면 문의자 이메일로 답변 본문만 보낸다',
      async (status) => {
        prisma.lead.findUnique.mockResolvedValue(
          lead({
            status,
            email: 'doyun@example.com',
            contactName: '[당첨] evil.example 에서 수령',
            internalMemo: '내부 메모',
          }),
        );
        await service.reply(3, 5, dto);
        await settle();

        // 문의자 이름은 싣지 않는다 — 비로그인 입력값이 확인되지 않은 주소로 가는 회사 명의 메일에 실린다
        // (재영 결정 2026-10-15, 운영 정책 CNT-11 v134). 접수 확인 메일을 고정 문구로 바꾼 것과 같은 이유다.
        expect(mail!.send).toHaveBeenCalledWith({
          templateCode: 'EMAIL_LEAD_REPLY',
          to: 'doyun@example.com',
          variables: { 답변: '다음 주에 방문 상담드리겠습니다' },
        });
        const sent = JSON.stringify(mail!.send.mock.calls);
        expect(sent).not.toContain('내부 메모');
        expect(sent).not.toContain('evil.example');
      },
    );

    it('답변을 고칠 때는 다시 보내지 않는다', async () => {
      prisma.lead.findUnique.mockResolvedValue(
        lead({ status: 'ANSWERED', email: 'doyun@example.com' }),
      );
      await service.reply(3, 5, dto);
      await settle();
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('409 면 보내지 않는다', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reply(3, 5, dto)).rejects.toThrow(ConflictException);
      await settle();
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('보내기를 기다리지 않고 응답한다', async () => {
      mail!.send.mockReturnValue(new Promise(() => {}));
      await expect(service.reply(3, 5, dto)).resolves.toEqual(saved);
    });

    it('메일이 실패해도 답변 저장은 성공이고 알림은 가며, 로그에 받는 주소를 남기지 않는다', async () => {
      mail!.send.mockRejectedValue(new Error('550 <doyun@example.com>'));
      await expect(service.reply(3, 5, dto)).resolves.toEqual(saved);
      await settle();

      expect(ops.notify).toHaveBeenCalled();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('lead reply mail FAILED lead=5'),
      );
      expect(JSON.stringify(logged.error.mock.calls)).not.toContain('doyun@');
    });

    it('MAIL_* 가 없으면 메일만 건너뛰고 남긴다', async () => {
      mail = null;
      await build();
      await service.reply(3, 5, dto);
      await settle();

      expect(ops.notify).toHaveBeenCalled();
      expect(logged.warn).toHaveBeenCalledWith(
        'lead reply mail SKIPPED no MAIL_* lead=5',
      );
    });

    // 운영자가 상세에서 보고 다시 보낼지 정한다(#597). 결과는 보낸 시각과 맞을 때만 쓴다 — 늦게 끝난 앞 발송이
    // 뒤 발송의 결과를 덮지 않게.
    it.each([
      ['보내면', () => {}, 'SUCCEEDED'],
      [
        '실패하면',
        () => mail!.send.mockRejectedValue(new Error('x')),
        'FAILED',
      ],
    ] as const)(
      '%s 결과와 보낸 시각을 도입문의에 남긴다',
      async (_, arrange, result) => {
        arrange();
        await service.reply(3, 5, dto);
        await settle();
        expect(prisma.$executeRaw).toHaveBeenCalledWith(
          expect.anything(),
          result,
          5,
          mailedAt,
        );
      },
    );

    it('MAIL_* 가 없으면 실패로 남긴다 — 운영자가 보고 다시 보낼 수 있게', async () => {
      mail = null;
      await build();
      await service.reply(3, 5, dto);
      await settle();
      expect(prisma.$executeRaw).toHaveBeenCalledWith(
        expect.anything(),
        'FAILED',
        5,
        mailedAt,
      );
    });

    // 첫 답변은 한 번뿐이라 이때 시각은 비어 있다. 그사이 다시 보내기가 먼저 잡았으면 두 통이 나가지 않게 보내지 않는다.
    it('비어 있을 때만 시각을 잡고 결과를 비운다', async () => {
      await service.reply(3, 5, dto);
      await settle();
      const text = (
        prisma.$queryRaw.mock.calls
          .map(([sql]) => (sql as TemplateStringsArray).join('?'))
          .find((t) => t.includes('reply_mail_attempted_at')) ?? ''
      ).replace(/\s+/g, ' ');
      expect(text).toContain('reply_mail_attempted_at IS NULL');
      expect(text).toContain('reply_mail_result = NULL');
    });

    it('다시 보내기가 먼저 시각을 잡았으면 보내지 않는다', async () => {
      claimed = [];
      await service.reply(3, 5, dto);
      await settle();
      expect(mail!.send).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(logged.error).not.toHaveBeenCalled();
    });

    it('답변을 고칠 때는 결과 칸도 건드리지 않는다', async () => {
      prisma.lead.findUnique.mockResolvedValue(
        lead({ status: 'ANSWERED', email: 'doyun@example.com' }),
      );
      await service.reply(3, 5, dto);
      await settle();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('답변 메일 다시 보내기 (#597)', () => {
    it('저장된 지금 답변을 문의자 이메일로 보내고, 보낸 운영자를 남기며 결과 · 시각을 준다', async () => {
      await expect(service.resendReplyMail(3, 5)).resolves.toEqual({
        replyMailResult: 'SUCCEEDED',
        replyMailAttemptedAt: mailedAt,
      });
      expect(mail!.send).toHaveBeenCalledWith({
        templateCode: 'EMAIL_LEAD_REPLY',
        to: 'doyun@example.com',
        variables: { 답변: '다음 주에 방문 상담드리겠습니다' },
        sentBy: 3,
      });
      expect(prisma.$executeRaw).toHaveBeenCalledWith(
        expect.anything(),
        'SUCCEEDED',
        5,
        mailedAt,
      );
    });

    // 1분 간격 · 답변완료 · 파기 기한을 시각을 잡는 UPDATE 하나의 조건으로 본다 — 동시에 눌러도 하나만 잡힌다.
    it('시각을 잡는 UPDATE 가 답변완료 · 1분 간격 · 파기 기한을 조건으로 건다', async () => {
      await service.resendReplyMail(3, 5);
      const [sql, ...values] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      const text = sql.join('?');
      expect(text).toContain(`status = 'ANSWERED'`);
      expect(text).toContain(`interval '1 minute'`);
      expect(text).toContain('consulted_date');
      // 보내는 동안 상세에 「새 시각 + 지난 결과」가 보이지 않게 결과를 비운다 — 시각만 있고 결과가 없으면 결과 모름.
      expect(text).toContain('reply_mail_result = NULL');
      // 한국 날짜 10-14 의 1년 전(파기 배치와 같은 기준)
      expect(values).toEqual([5, '2025-10-14']);
    });

    it('메일이 실패하면 실패로 남기고 돌려주며, 로그에 받는 주소를 남기지 않는다', async () => {
      mail!.send.mockRejectedValue(new Error('550 <doyun@example.com>'));
      await expect(service.resendReplyMail(3, 5)).resolves.toEqual({
        replyMailResult: 'FAILED',
        replyMailAttemptedAt: mailedAt,
      });
      expect(prisma.$executeRaw).toHaveBeenCalledWith(
        expect.anything(),
        'FAILED',
        5,
        mailedAt,
      );
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('lead reply mail FAILED lead=5'),
      );
      expect(JSON.stringify(logged.error.mock.calls)).not.toContain('doyun@');
    });

    it('결과는 잡은 시각이 그대로일 때만 쓴다 — 늦게 끝난 앞 발송이 뒤 결과를 덮지 않게', async () => {
      await service.resendReplyMail(3, 5);
      const [sql] = prisma.$executeRaw.mock.calls[0] as [TemplateStringsArray];
      expect(sql.join('?').replace(/\s+/g, ' ')).toContain(
        'AND reply_mail_attempted_at = ?',
      );
    });

    it('결과를 남기지 못해도 500 이 아니라 보낸 결과를 준다 — 메일은 이미 나갔다', async () => {
      prisma.$executeRaw.mockRejectedValue(
        Object.assign(new Error('db down'), { code: 'P1001' }),
      );
      await expect(service.resendReplyMail(3, 5)).resolves.toEqual({
        replyMailResult: 'SUCCEEDED',
        replyMailAttemptedAt: mailedAt,
      });
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'lead reply mail result NOT RECORDED lead=5 result=SUCCEEDED',
        ),
      );
    });

    it('그사이 시각이 바뀌어(뒤 발송 · 삭제) 결과를 쓰지 못했으면 남긴다', async () => {
      prisma.$executeRaw.mockResolvedValue(0);
      await service.resendReplyMail(3, 5);
      expect(logged.warn).toHaveBeenCalledWith(
        'lead reply mail result SUPERSEDED lead=5 result=SUCCEEDED',
      );
    });

    // 같은 저장소의 재설정 링크 발급(WHALEERP-172)과 같다. 시각을 잡지 않으니 설정을 고친 뒤 바로 보낼 수 있다.
    it('MAIL_* 가 없으면 시각을 잡지 않고 503', async () => {
      mail = null;
      await build();
      await expect(service.resendReplyMail(3, 5)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    describe('잡히지 않으면', () => {
      beforeEach(() => {
        claimed = [];
      });

      it('없거나 파기 기한이 지났으면 404', async () => {
        prisma.lead.findFirst.mockResolvedValue(null);
        await expect(service.resendReplyMail(3, 5)).rejects.toThrow(
          NotFoundException,
        );
        expect(mail!.send).not.toHaveBeenCalled();
      });

      it.each(['RECEIVED', 'IN_PROGRESS'])(
        '%s 면 409 — 답변완료만 다시 보낸다',
        async (status) => {
          prisma.lead.findFirst.mockResolvedValue({ status, reply: null });
          await expect(service.resendReplyMail(3, 5)).rejects.toThrow(
            '답변완료 도입문의만 답변 메일을 다시 보낼 수 있습니다.',
          );
        },
      );

      it('답변완료인데 답변이 비어 있으면 1분 문구가 아니라 답변완료 문구', async () => {
        prisma.lead.findFirst.mockResolvedValue({
          status: 'ANSWERED',
          reply: null,
        });
        await expect(service.resendReplyMail(3, 5)).rejects.toThrow(
          '답변완료 도입문의만 답변 메일을 다시 보낼 수 있습니다.',
        );
      });

      it('답변완료인데 잡히지 않았으면 1분이 지나지 않은 것이라 409', async () => {
        prisma.lead.findFirst.mockResolvedValue({
          status: 'ANSWERED',
          reply: '연락드렸습니다',
        });
        await expect(service.resendReplyMail(3, 5)).rejects.toThrow(
          '방금 답변 메일을 보냈습니다. 1분 뒤 다시 보내 주세요.',
        );
        expect(mail!.send).not.toHaveBeenCalled();
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
      });
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

  // 파기 배치(lead-purge)와 같은 기준: 상담 완료일이 한국 날짜로 1년 전보다 앞서면 파기 대상이다. 지금은 한국 10-14 라
  // 2025-10-14 부터 남는다. 배치가 하루 실패해도 조회에는 나오지 않는다.
  const kept = {
    OR: [
      { consultedDate: null },
      { consultedDate: { gte: new Date('2025-10-14T00:00:00Z') } },
    ],
  };

  describe('list', () => {
    const row = {
      leadId: 5,
      contactName: '조민석',
      phone: '02-514-7741',
      industryCode: 'CAFE',
      industryDetail: null,
      interests: ['STORE_OPERATION'],
      status: 'RECEIVED',
      createdAt: new Date('2026-09-06T06:47:00Z'),
    };

    it('접수 최신순 한 쪽과 같은 조건의 전체 건수를 준다', async () => {
      prisma.lead.findMany.mockResolvedValue([row]);
      prisma.lead.count.mockResolvedValue(21);
      const result = await service.list({ page: 3, pageSize: 10 });
      expect(prisma.lead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [kept, {}] },
          orderBy: [{ createdAt: 'desc' }, { leadId: 'desc' }],
          skip: 20,
          take: 10,
        }),
      );
      expect(prisma.lead.count).toHaveBeenCalledWith({
        where: { AND: [kept, {}] },
      });
      expect(result).toEqual({ items: [row], total: 21 });
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
      const where = { AND: [kept, { status: { in: statuses } }] };
      expect(prisma.lead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(prisma.lead.count).toHaveBeenCalledWith({ where });
    });
  });

  describe('get', () => {
    const found = {
      leadId: 5,
      contactName: '조민석',
      industryCode: 'CAFE',
      industryDetail: null,
      phone: '02-514-7741',
      email: 'ms.cho@example.com',
      interests: ['STORE_OPERATION'],
      planPeriodCode: 'WITHIN_3_MONTHS',
      body: '가맹점 요금이 궁금합니다',
      privacyAgreedAt: new Date('2026-09-06T06:47:00Z'),
      marketingAgreedAt: null,
      status: 'ANSWERED',
      processingStartedBy: 3,
      processingStartedAt: new Date('2026-09-06T07:00:00Z'),
      reply: '본사 초대로 들어오면 됩니다',
      repliedBy: 4,
      repliedAt: new Date('2026-09-06T08:00:00Z'),
      replyMailResult: 'FAILED',
      replyMailAttemptedAt: new Date('2026-09-06T08:00:01Z'),
      internalMemo: null,
      createdAt: new Date('2026-09-06T06:47:00Z'),
      updatedAt,
      // 날짜만 있는 칸은 UTC 자정 Date 로 온다.
      consultedDate: new Date('2026-09-06T00:00:00Z'),
    };

    it('모든 칸과 처리한 관리자 이름을 주고, 상담 완료일은 날짜 글자다', async () => {
      prisma.lead.findFirst.mockResolvedValue(found);
      prisma.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: 3, name: '이서준' },
        { adminAccountId: 4, name: '김지영' },
      ]);
      await expect(service.get(5)).resolves.toEqual({
        ...found,
        consultedDate: '2026-09-06',
        processingStartedByName: '이서준',
        repliedByName: '김지영',
      });
      expect(prisma.lead.findFirst).toHaveBeenCalledWith({
        where: { leadId: 5, ...kept },
      });
    });

    // 테이블에 칸이 더해져도 응답에 저절로 실리지 않는다 — 내보낼 칸은 DTO 에 적은 것뿐이다.
    it('행에 다른 칸이 있어도 응답에 싣지 않는다', async () => {
      prisma.lead.findFirst.mockResolvedValue({ ...found, futureColumn: 'x' });
      await expect(service.get(5)).resolves.not.toHaveProperty('futureColumn');
    });

    it('처리하지 않았으면 이름 칸도 null 이다', async () => {
      prisma.lead.findFirst.mockResolvedValue({
        ...found,
        processingStartedBy: null,
        processingStartedAt: null,
        repliedBy: null,
        repliedAt: null,
        reply: null,
        consultedDate: null,
      });
      prisma.adminAccount.findMany.mockClear();
      const result = await service.get(5);
      expect(result).toMatchObject({
        processingStartedByName: null,
        repliedByName: null,
        consultedDate: null,
      });
      expect(prisma.adminAccount.findMany).not.toHaveBeenCalled();
    });

    it('없거나 파기 기한이 지났으면 404', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(service.get(5)).rejects.toThrow(NotFoundException);
    });
  });

  // 운영 정책 CNT-11: 상담하지 않은 도입문의는 운영자가 지우고, 상담을 마친 건은 1년 뒤 배치가 파기한다.
  describe('remove', () => {
    it('상담 완료일이 없고 답변하지 않은 건만 행째 지우고, 지운 관리자를 로그에 남긴다', async () => {
      await service.remove(3, 5);
      // 조건을 DELETE 에 넣어, 그사이 답변이 저장됐으면 지우지 않는다. 상담 완료일 없이 답변완료가 된 옛 행도
      // 답변한 건이라 지우지 않는다.
      expect(prisma.lead.deleteMany).toHaveBeenCalledWith({
        where: {
          leadId: 5,
          consultedDate: null,
          status: { not: 'ANSWERED' },
        },
      });
      expect(logged.log).toHaveBeenCalledWith(
        expect.stringMatching(/lead=5 .*admin=3/),
      );
    });

    // 운영 정책 CNT-11 의 파기: 알림 본문에 남은 문의자 이름도 지운다(2026-10-15 재영).
    it('같은 트랜잭션에서 그 도입문의의 운영 알림도 지운다', async () => {
      await service.remove(3, 5);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { relatedType: 'LEAD', relatedId: { in: [5] } },
      });
    });

    it('없거나 파기 기한이 지났으면 404', async () => {
      prisma.lead.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove(3, 5)).rejects.toThrow(NotFoundException);
      expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
      expect(prisma.lead.findFirst).toHaveBeenCalledWith({
        where: { leadId: 5, ...kept },
        select: { leadId: true },
      });
      expect(logged.log).not.toHaveBeenCalled();
    });

    it('상담을 마친 도입문의는 409', async () => {
      prisma.lead.deleteMany.mockResolvedValue({ count: 0 });
      prisma.lead.findFirst.mockResolvedValue({ leadId: 5 });
      await expect(service.remove(3, 5)).rejects.toThrow(
        '상담을 마친 도입문의는 지울 수 없습니다.',
      );
      expect(logged.log).not.toHaveBeenCalled();
    });
  });
});
