import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { BatchLockService } from './batch-lock.service';
import { BATCH_JOB } from './batch-job-names';

describe('BatchLockService', () => {
  let service: BatchLockService;
  let tx: { $queryRaw: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  let logLog: jest.SpyInstance;
  let logError: jest.SpyInstance;

  beforeEach(async () => {
    // 로그는 실행 기록 테이블이 생기기 전까지 유일한 관측 수단이라 문구를 고정한다.
    logLog = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    tx = { $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]) };
    prisma = {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchLockService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(BatchLockService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('락을 얻으면 같은 트랜잭션으로 작업을 실행하고 처리 건수를 돌려준다', async () => {
    const work = jest.fn().mockResolvedValue(3);

    const result = await service.runExclusive(BATCH_JOB.CONTRACT_EXPIRE, work);

    expect(work).toHaveBeenCalledWith(tx);
    expect(result).toEqual({ ran: true, processed: 3 });
    expect(logLog).toHaveBeenCalledWith('contract-expire RAN processed=3');
  });

  it('락 키는 잡 이름이다', async () => {
    await service.runExclusive(BATCH_JOB.CONTRACT_EXPIRE, jest.fn());

    const [sql, ...values] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join('?')).toContain('pg_try_advisory_xact_lock(hashtext(?))');
    expect(values).toEqual(['contract-expire']);
  });

  it('락을 못 얻으면 작업을 호출하지 않는다', async () => {
    tx.$queryRaw.mockResolvedValue([{ acquired: false }]);
    const work = jest.fn();

    const result = await service.runExclusive(BATCH_JOB.CONTRACT_EXPIRE, work);

    expect(work).not.toHaveBeenCalled();
    expect(result).toEqual({ ran: false, processed: 0 });
    expect(logLog).toHaveBeenCalledWith('contract-expire SKIPPED_LOCKED');
  });

  it('작업이 던진 예외는 FAILED 로 남기고 그대로 전파한다', async () => {
    const error = new Error('boom');

    await expect(
      service.runExclusive(
        BATCH_JOB.CONTRACT_EXPIRE,
        jest.fn().mockRejectedValue(error),
      ),
    ).rejects.toBe(error);
    expect(logError).toHaveBeenCalledWith(
      'contract-expire FAILED',
      error.stack,
    );
  });

  it('Error 가 아닌 값이 던져져도 FAILED 로그에 그 값을 남긴다', async () => {
    await expect(
      service.runExclusive(
        BATCH_JOB.CONTRACT_EXPIRE,
        jest.fn().mockRejectedValue('boom'),
      ),
    ).rejects.toBe('boom');
    expect(logError).toHaveBeenCalledWith('contract-expire FAILED', 'boom');
  });

  it('배치용 트랜잭션 타임아웃을 쓴다', async () => {
    await service.runExclusive(BATCH_JOB.CONTRACT_EXPIRE, jest.fn());

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 60_000,
      maxWait: 5_000,
    });
  });
});
