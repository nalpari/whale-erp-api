import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadsService } from './leads.service';

// 접수 알림 · 메일은 응답을 기다리게 하지 않고 뒤에서 보낸다. 그 일이 끝날 때까지 기다린다.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('LeadsService', () => {
  let service: LeadsService;
  let prisma: {
    codeItem: { count: jest.Mock; findFirst: jest.Mock };
    lead: { findUnique: jest.Mock };
    adminAccount: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let ops: { notify: jest.Mock };
  let mail: { send: jest.Mock } | null;
  let logged: { error: jest.SpyInstance; warn: jest.SpyInstance };
  // 트랜잭션 안의 클라이언트. prisma 와 따로 두어야 잠금 · 확인 · 저장이 트랜잭션 밖으로
  // 새는 회귀(잠금이 바로 풀려 동시 제출이 둘 다 저장됨)를 잡는다.
  let tx: {
    lead: { create: jest.Mock };
    $executeRaw: jest.Mock;
    // 10분 안 재접수 확인. 기본은 없다.
    $queryRaw: jest.Mock;
    notificationDelivery: { deleteMany: jest.Mock };
    notificationRecipient: { deleteMany: jest.Mock };
    notification: { deleteMany: jest.Mock };
  };
  const now = new Date('2026-10-13T03:00:00Z');
  // 최근 1시간에 들어온 도입문의 수(방금 넣은 것 포함). 기본은 한도 아래.
  let received: number;
  let leadStillThere: { leadId: number }[];
  const isHourlyCount = (sql: TemplateStringsArray) =>
    sql.join('?').includes('count(*)');
  type RawCall = [TemplateStringsArray, ...unknown[]];
  const hourlyCountCalls = () =>
    (prisma.$queryRaw.mock.calls as RawCall[])
      .map((c, i) => [c, prisma.$queryRaw.mock.invocationCallOrder[i]] as const)
      .filter(([c]) => isHourlyCount(c[0]));

  const dto = (over: Partial<CreateLeadDto> = {}): CreateLeadDto =>
    Object.assign(new CreateLeadDto(), {
      contactName: '김도윤',
      industryCode: 'CAFE',
      phone: '0212345678',
      email: 'doyun@example.com',
      interests: ['STORE_OPERATION'],
      planPeriodCode: 'WITHIN_1M',
      body: '도입 비용이 궁금합니다',
      privacyAgreed: true,
      ...over,
    });

  const build = async () => {
    const module = await Test.createTestingModule({
      providers: [
        LeadsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpsNotificationService, useValue: ops },
        { provide: OPTIONAL_MAIL_SERVICE, useValue: mail },
      ],
    }).compile();
    service = module.get(LeadsService);
    logged = {
      error: jest.spyOn(service['logger'], 'error').mockImplementation(),
      warn: jest.spyOn(service['logger'], 'warn').mockImplementation(),
    };
  };

  beforeEach(async () => {
    jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
    received = 1;
    leadStillThere = [{ leadId: 5 }];
    prisma = {
      codeItem: {
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue({ label: '카페' }),
      },
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          contactName: '김도윤',
          industryCode: 'CAFE',
          industryDetail: null,
        }),
      },
      adminAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ adminAccountId: 1 }, { adminAccountId: 2 }]),
      },
      // 확인 메일 상한을 세는 쿼리와, 알림을 만든 뒤 도입문의가 아직 있는지 다시 보는 쿼리(#590)를 글로 가른다.
      $queryRaw: jest.fn((sql: TemplateStringsArray) =>
        Promise.resolve(isHourlyCount(sql) ? [{ received }] : leadStillThere),
      ),
      $transaction: jest.fn((work: (t: object) => unknown) => work(tx)),
    };
    tx = {
      lead: {
        create: jest.fn().mockResolvedValue({ leadId: 5 }),
      },
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
      notificationDelivery: { deleteMany: jest.fn() },
      notificationRecipient: { deleteMany: jest.fn() },
      notification: { deleteMany: jest.fn() },
    };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm' }) };
    await build();
  });

  afterEach(() => jest.useRealTimers());

  type Call = [{ data: Record<string, unknown>; where: { groupCode: string } }];
  const savedData = (i = 0) => (tx.lead.create.mock.calls as Call[])[i][0].data;

  it('받은 값과 개인정보 동의 일시로 접수한다', async () => {
    await service.create(dto());

    expect(tx.lead.create).toHaveBeenCalledWith({
      select: { leadId: true },
      data: {
        contactName: '김도윤',
        industryCode: 'CAFE',
        industryDetail: null,
        phone: '0212345678',
        email: 'doyun@example.com',
        interests: ['STORE_OPERATION'],
        planPeriodCode: 'WITHIN_1M',
        body: '도입 비용이 궁금합니다',
        privacyAgreedAt: now,
        marketingAgreedAt: null,
      },
    });
  });

  it('마케팅 수신에 동의하면 그 일시도 저장한다', async () => {
    await service.create(dto({ marketingAgreed: true }));

    expect(savedData().marketingAgreedAt).toEqual(now);
  });

  it('업종이 기타일 때만 직접 입력을 저장한다', async () => {
    await service.create(dto({ industryDetail: '꽃집' }));
    await service.create(dto({ industryCode: 'ETC', industryDetail: '꽃집' }));

    expect([savedData(0), savedData(1)].map((d) => d.industryDetail)).toEqual([
      null,
      '꽃집',
    ]);
  });

  it.each([undefined, null])(
    '도입 예정 시기를 안 고르면(%s) 공통코드를 찾지 않고 비워 둔다',
    async (planPeriodCode) => {
      await service.create(dto({ planPeriodCode }));

      expect(savedData().planPeriodCode).toBeNull();
      expect(prisma.codeItem.count).toHaveBeenCalledTimes(1);
    },
  );

  it('업종은 사용 중인 플랫폼 공통코드여야 한다', async () => {
    prisma.codeItem.count.mockResolvedValueOnce(0);

    await expect(service.create(dto())).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: '업종을 다시 선택해 주세요',
    });
    expect(prisma.codeItem.count).toHaveBeenCalledWith({
      where: {
        groupCode: 'INDUSTRY',
        itemCode: 'CAFE',
        bpCode: 'BP000000',
        status: 'ACTIVE',
        isDeleted: false,
      },
    });
    expect(tx.lead.create).not.toHaveBeenCalled();
  });

  it('도입 예정 시기도 사용 중인 공통코드여야 한다', async () => {
    prisma.codeItem.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(service.create(dto())).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: '도입 예정 시기를 다시 선택해 주세요',
    });
    expect(
      (prisma.codeItem.count.mock.calls as Call[])[1][0].where.groupCode,
    ).toBe('PLAN_PERIOD');
  });

  it('같은 전화번호나 이메일로 10분 안에 접수된 것이 있으면 429 로 막는다', async () => {
    tx.$queryRaw.mockResolvedValue([{ leadId: 1 }]);

    await expect(service.create(dto())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      message:
        '이미 접수된 문의가 있습니다. 담당자가 영업일 기준 1~2일 안에 연락드립니다',
    });
    // 10분 기준도 DB 시계다 — created_at 을 DB 가 채우므로 앱 서버 시계를 섞지 않는다.
    const [[sql, ...params]] = tx.$queryRaw.mock.calls as [
      TemplateStringsArray,
      ...unknown[],
    ][];
    expect(sql.join('?')).toMatch(
      /FROM "leads"\s+WHERE "created_at" > now\(\) - interval '10 minutes'\s+AND \("phone" = \? OR "email" = \?\)/,
    );
    expect(params).toEqual(['0212345678', 'doyun@example.com']);
    expect(tx.lead.create).not.toHaveBeenCalled();
  });

  it('동시에 온 같은 문의가 둘 다 들어가지 않게 잠근 뒤 확인하고 저장한다', async () => {
    await service.create(dto());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // 전화번호 · 이메일 키를 이 순서로 잠근다. 순서가 늘 같아야 두 요청이 서로를 기다리지 않는다.
    const keys = (tx.$executeRaw.mock.calls as [string[], string][]).map(
      ([sql, key]) => {
        expect(sql.join('?')).toMatch(/pg_advisory_xact_lock/);
        return key;
      },
    );
    expect(keys).toEqual([
      'lead-intake:phone:0212345678',
      'lead-intake:email:doyun@example.com',
    ]);
    const lock = Math.max(...tx.$executeRaw.mock.invocationCallOrder);
    const [check] = tx.$queryRaw.mock.invocationCallOrder;
    const [save] = tx.lead.create.mock.invocationCallOrder;
    expect(lock).toBeLessThan(check);
    expect(check).toBeLessThan(save);
  });

  it('상담 완료일로부터 1년이 지난 도입문의를 그 운영 알림과 함께 파기하고 건수를 돌려준다', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ leadId: 7 }, { leadId: 8 }]),
      notificationDelivery: { deleteMany: jest.fn() },
      notificationRecipient: { deleteMany: jest.fn() },
      notification: { deleteMany: jest.fn() },
    };

    await expect(
      service.purgeExpired(tx as unknown as Prisma.TransactionClient),
    ).resolves.toBe(2);
    const sql = (tx.$queryRaw.mock.calls as string[][][])[0][0].join('?');
    expect(sql).toMatch(/DELETE FROM "leads"/);
    expect(sql).toMatch(/"consulted_date" < /);
    expect(sql).toMatch(/Asia\/Seoul/);
    expect(sql).toMatch(/interval '1 year'/);
    expect(sql).toMatch(/RETURNING "lead_id"/);
    // 알림 본문에 문의자 이름이 남으면 파기가 아니다(운영 정책 CNT-11, 2026-10-15 재영).
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({
      where: { relatedType: 'LEAD', relatedId: { in: [7, 8] } },
    });
  });

  describe('접수 알림과 확인 메일 (#296)', () => {
    it('플랫폼 운영자에게 운영 알림을 보낸다', async () => {
      await service.create(dto());
      await settle();

      expect(ops.notify).toHaveBeenCalledWith({
        templateCode: 'NTF_LEAD_RECEIVED',
        variables: { 도입문의자: '김도윤 · 카페' },
        related: { type: 'LEAD', id: 5 },
        link: '/platform-leads/5',
        eventKey: '5',
        recipients: [1, 2],
      });
    });

    // 비로그인 접수라 주소가 확인되지 않았다. 입력값이 회사 명의 메일에 실리면 남의 주소로 피싱 문구를
    // 보낼 수 있어 접수 확인 메일은 고정 문구다(재영 결정 2026-10-15, api #50 리뷰).
    it('문의자가 적은 이메일로 고정 문구의 접수 확인 메일을 보낸다 — 입력값을 싣지 않는다', async () => {
      await service.create(
        dto({ contactName: '[당첨] evil.example 에서 수령' }),
      );
      await settle();

      expect(mail!.send).toHaveBeenCalledWith({
        templateCode: 'EMAIL_LEAD_CONFIRMATION',
        to: 'doyun@example.com',
        variables: {},
      });
    });

    // 접수 IP 한도만으로는 IP 를 바꿔 가며 메일을 끝없이 보내게 할 수 있다 — Gmail 한도가 다 차면 가입 메일 등도
    // 막힌다. 서비스 전체 시간당 50건(재영 결정 2026-10-15). 메일 이력은 SMTP 응답 뒤에야 생겨 보내는 중인 메일을
    // 못 세므로, 메일보다 먼저 커밋되는 도입문의 행을 센다(api #50 재리뷰).
    it('최근 1시간 도입문의가 방금 것을 넣어 51건이면 접수와 알림은 그대로 두고 메일만 건너뛴다', async () => {
      received = 51;

      await expect(service.create(dto())).resolves.toBeUndefined();
      await settle();

      // 1시간 기준은 DB 시계로 잡는다 — created_at 도 DB 가 채우므로 두 시계를 섞지 않는다.
      const [[[sql, ...params]]] = hourlyCountCalls();
      expect(sql.join('?')).toMatch(
        /FROM "leads"\s+WHERE "created_at" > now\(\) - interval '1 hour'/,
      );
      expect(params).toEqual([]);
      expect(mail!.send).not.toHaveBeenCalled();
      expect(ops.notify).toHaveBeenCalled();
      expect(logged.warn).toHaveBeenCalledWith(
        'lead confirmation mail SKIPPED hourly limit 50 lead=5',
      );
    });

    it('방금 것을 넣어 50건이면 보낸다', async () => {
      received = 50;
      await service.create(dto());
      await settle();
      expect(mail!.send).toHaveBeenCalled();
    });

    // 세는 것은 접수가 커밋된 뒤다 — 동시에 몰려도 51번째 이후로 커밋된 접수는 언제 세도 51 이상을 본다.
    it('도입문의를 저장한 뒤에 센다', async () => {
      await service.create(dto());
      await settle();
      // 호출 여부부터 본다 — 안 불리면 Math.min() 이 Infinity 라 순서 비교만으로는 통과한다.
      const counts = hourlyCountCalls();
      expect(counts).toHaveLength(1);
      expect(tx.lead.create).toHaveBeenCalledTimes(1);
      expect(counts[0][1]).toBeGreaterThan(
        tx.lead.create.mock.invocationCallOrder[0],
      );
    });

    it('업종이 기타면 직접 입력한 업종을 쓴다', async () => {
      prisma.lead.findUnique.mockResolvedValue({
        contactName: '김도윤',
        industryCode: 'ETC',
        industryDetail: '꽃집',
      });
      await service.create(
        dto({ industryCode: 'ETC', industryDetail: '꽃집' }),
      );
      await settle();

      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { 도입문의자: '김도윤 · 꽃집' } }),
      );
    });

    it('보내기를 기다리지 않고 응답한다', async () => {
      mail!.send.mockReturnValue(new Promise(() => {}));
      ops.notify.mockReturnValue(new Promise(() => {}));

      await expect(service.create(dto())).resolves.toBeUndefined();
    });

    it('메일이 실패해도 접수는 성공이고 알림은 가며, 로그에 받는 주소를 남기지 않는다', async () => {
      mail!.send.mockRejectedValue(new Error('550 <doyun@example.com>'));

      await expect(service.create(dto())).resolves.toBeUndefined();
      await settle();

      expect(ops.notify).toHaveBeenCalled();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('lead confirmation mail FAILED lead=5'),
      );
      expect(JSON.stringify(logged.error.mock.calls)).not.toContain('doyun@');
    });

    it('알림 준비가 실패해도 접수는 성공이고 메일은 간다', async () => {
      prisma.adminAccount.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.create(dto())).resolves.toBeUndefined();
      await settle();

      expect(mail!.send).toHaveBeenCalled();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('lead received notification FAILED lead=5'),
      );
    });

    it('알림을 만든 사이 도입문의가 지워졌으면(#590) 그 알림을 지운다', async () => {
      leadStillThere = [];
      await service.create(dto());
      await settle();

      expect(ops.notify).toHaveBeenCalled();
      expect(tx.notification.deleteMany).toHaveBeenCalledWith({
        where: { relatedType: 'LEAD', relatedId: { in: [5] } },
      });
    });

    it('업종 이름을 못 읽어도 접수는 성공이고, 알림만 실패로 남고 확인 메일은 간다', async () => {
      prisma.codeItem.findFirst.mockRejectedValue(new Error('db down'));

      await expect(service.create(dto())).resolves.toBeUndefined();
      await settle();

      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('lead received notification FAILED lead=5'),
      );
      expect(mail!.send).toHaveBeenCalled();
    });

    it('보낸 건수를 못 세면 메일을 보내지 않고 실패로 남긴다', async () => {
      prisma.$queryRaw.mockImplementation((sql: TemplateStringsArray) =>
        isHourlyCount(sql)
          ? Promise.reject(new Error('db down'))
          : Promise.resolve(leadStillThere),
      );

      await expect(service.create(dto())).resolves.toBeUndefined();
      await settle();

      expect(mail!.send).not.toHaveBeenCalled();
      expect(logged.error).toHaveBeenCalledWith(
        expect.stringContaining('lead confirmation mail FAILED lead=5'),
      );
    });

    it('MAIL_* 가 없으면 메일만 건너뛰고 남긴다', async () => {
      mail = null;
      await build();

      await service.create(dto());
      await settle();

      expect(ops.notify).toHaveBeenCalled();
      expect(logged.warn).toHaveBeenCalledWith(
        'lead confirmation mail SKIPPED no MAIL_* lead=5',
      );
    });

    it('막힌 접수(429)는 아무것도 보내지 않는다', async () => {
      tx.$queryRaw.mockResolvedValue([{ leadId: 1 }]);

      await expect(service.create(dto())).rejects.toThrow();
      await settle();

      expect(ops.notify).not.toHaveBeenCalled();
      expect(mail!.send).not.toHaveBeenCalled();
    });
  });
});
