import { CronExpression } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { BatchLockService } from '../batch/batch-lock.service';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';
import { ContractNoticeService } from './contract-notice.service';

describe('ContractExpiryScheduler', () => {
  let scheduler: ContractExpiryScheduler;
  let lock: { runExclusive: jest.Mock };
  let expiry: { runDaily: jest.Mock };
  let notice: { statusChanged: jest.Mock; renewalDue: jest.Mock };
  const tx = {};
  const result = {
    expired: [
      { contractId: 1, historyId: 101 },
      { contractId: 2, historyId: 102 },
    ],
    invitationsExpired: 3,
    ended: [7],
    renewalDue: [9],
  };

  beforeEach(async () => {
    lock = {
      runExclusive: jest.fn(
        async (_name: string, work: (t: object) => Promise<number>) => ({
          ran: true,
          processed: await work(tx),
        }),
      ),
    };
    expiry = { runDaily: jest.fn().mockResolvedValue(result) };
    notice = {
      statusChanged: jest.fn().mockResolvedValue(undefined),
      renewalDue: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractExpiryScheduler,
        { provide: BatchLockService, useValue: lock },
        { provide: ContractExpiryService, useValue: expiry },
        { provide: ContractNoticeService, useValue: notice },
      ],
    }).compile();
    scheduler = module.get(ContractExpiryScheduler);
  });

  it('contract-expire 락 안에서 하루 배치를 실행하고 바꾼 건수를 넘긴다', async () => {
    await scheduler.expireContracts();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'contract-expire',
      expect.any(Function),
    );
    expect(expiry.runDaily).toHaveBeenCalledWith(tx);
    await expect(
      (lock.runExclusive.mock.results[0] as { value: Promise<unknown> }).value,
    ).resolves.toEqual({ ran: true, processed: 7 });
  });

  it('커밋 뒤 만료(상태 이력 ID) · 갱신 예정을 관리자에게 알린다', async () => {
    await scheduler.expireContracts();

    expect(notice.statusChanged.mock.calls).toEqual([
      ['EXPIRED', 1, 101],
      ['EXPIRED', 2, 102],
    ]);
    expect(notice.renewalDue).toHaveBeenCalledWith(9);
  });

  it('다른 실행이 락을 쥐고 있어 건너뛰면 알리지 않는다', async () => {
    lock.runExclusive.mockResolvedValue({ ran: false, processed: 0 });

    await scheduler.expireContracts();

    expect(notice.statusChanged).not.toHaveBeenCalled();
    expect(notice.renewalDue).not.toHaveBeenCalled();
  });

  it('배치가 실패하면(되돌려졌으면) 알리지 않고 그 오류를 던진다', async () => {
    lock.runExclusive.mockRejectedValue(new Error('db down'));

    await expect(scheduler.expireContracts()).rejects.toThrow('db down');
    expect(notice.statusChanged).not.toHaveBeenCalled();
  });

  it('서울 시각 자정에 돈다', () => {
    // 키는 @nestjs/schedule 내부 상수(SCHEDULE_CRON_OPTIONS)다. 패키지가 export 하지 않는다.
    const handler = Object.getOwnPropertyDescriptor(
      ContractExpiryScheduler.prototype,
      'expireContracts',
    )?.value as object;
    const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler) as {
      cronTime: string;
      timeZone: string;
    };

    expect(options).toMatchObject({
      cronTime: CronExpression.EVERY_DAY_AT_MIDNIGHT,
      timeZone: 'Asia/Seoul',
    });
  });
});
