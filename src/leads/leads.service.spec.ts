import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadsService } from './leads.service';

describe('LeadsService', () => {
  let service: LeadsService;
  let prisma: {
    codeItem: { count: jest.Mock };
    $transaction: jest.Mock;
  };
  // 트랜잭션 안의 클라이언트. prisma 와 따로 두어야 잠금 · 확인 · 저장이 트랜잭션 밖으로
  // 새는 회귀(잠금이 바로 풀려 동시 제출이 둘 다 저장됨)를 잡는다.
  let tx: {
    lead: { findFirst: jest.Mock; create: jest.Mock };
    $executeRaw: jest.Mock;
  };
  const now = new Date('2026-10-13T03:00:00Z');

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

  beforeEach(async () => {
    jest.useFakeTimers({ now });
    prisma = {
      codeItem: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((work: (t: object) => unknown) => work(tx)),
    };
    tx = {
      lead: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      $executeRaw: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [LeadsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(LeadsService);
  });

  afterEach(() => jest.useRealTimers());

  type Call = [{ data: Record<string, unknown>; where: { groupCode: string } }];
  const savedData = (i = 0) => (tx.lead.create.mock.calls as Call[])[i][0].data;

  it('받은 값과 개인정보 동의 일시로 접수한다', async () => {
    await service.create(dto());

    expect(tx.lead.create).toHaveBeenCalledWith({
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

  it('도입 예정 시기를 안 고르면 비워 둔다', async () => {
    await service.create(dto({ planPeriodCode: undefined }));

    expect(savedData().planPeriodCode).toBeNull();
    expect(prisma.codeItem.count).toHaveBeenCalledTimes(1);
  });

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
    tx.lead.findFirst.mockResolvedValue({ leadId: 1 });

    await expect(service.create(dto())).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(tx.lead.findFirst).toHaveBeenCalledWith({
      where: {
        createdAt: { gt: new Date(now.getTime() - 10 * 60_000) },
        OR: [{ phone: '0212345678' }, { email: 'doyun@example.com' }],
      },
      select: { leadId: true },
    });
    expect(tx.lead.create).not.toHaveBeenCalled();
  });

  it('동시에 온 같은 문의가 둘 다 들어가지 않게 잠근 뒤 확인하고 저장한다', async () => {
    await service.create(dto());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = (tx.$executeRaw.mock.calls as string[][][])[0][0].join('?');
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    const [lock] = tx.$executeRaw.mock.invocationCallOrder;
    const [check] = tx.lead.findFirst.mock.invocationCallOrder;
    const [save] = tx.lead.create.mock.invocationCallOrder;
    expect(lock).toBeLessThan(check);
    expect(check).toBeLessThan(save);
  });

  it('상담 완료일로부터 1년이 지난 도입문의를 파기하고 건수를 돌려준다', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(3) };

    await expect(
      service.purgeExpired(tx as unknown as Prisma.TransactionClient),
    ).resolves.toBe(3);
    const sql = (tx.$executeRaw.mock.calls as string[][][])[0][0].join('?');
    expect(sql).toMatch(/DELETE FROM "leads"/);
    expect(sql).toMatch(/"consulted_date" < /);
    expect(sql).toMatch(/Asia\/Seoul/);
    expect(sql).toMatch(/interval '1 year'/);
  });
});
