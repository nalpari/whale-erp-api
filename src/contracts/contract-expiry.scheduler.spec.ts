import { CronExpression } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { BatchLockService } from '../batch/batch-lock.service';
import { ContractExpiryScheduler } from './contract-expiry.scheduler';
import { ContractExpiryService } from './contract-expiry.service';

describe('ContractExpiryScheduler', () => {
  let scheduler: ContractExpiryScheduler;
  let lock: { runExclusive: jest.Mock };
  let expiry: { expireOverdue: jest.Mock };

  beforeEach(async () => {
    const tx = {};
    lock = {
      runExclusive: jest.fn((_name, work: (t: object) => unknown) => work(tx)),
    };
    expiry = { expireOverdue: jest.fn().mockResolvedValue(2) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractExpiryScheduler,
        { provide: BatchLockService, useValue: lock },
        { provide: ContractExpiryService, useValue: expiry },
      ],
    }).compile();
    scheduler = module.get(ContractExpiryScheduler);
  });

  it('contract-expire 락 안에서 만료 처리를 실행한다', async () => {
    await scheduler.expireContracts();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'contract-expire',
      expect.any(Function),
    );
    expect(expiry.expireOverdue).toHaveBeenCalledWith({});
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
