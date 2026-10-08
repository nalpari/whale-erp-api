import { CronExpression } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { BatchLockService } from '../batch/batch-lock.service';
import { RetirementScheduler } from './retirement.scheduler';
import { RetirementService } from './retirement.service';

describe('RetirementScheduler', () => {
  let scheduler: RetirementScheduler;
  let lock: { runExclusive: jest.Mock };
  let retirement: { retireDue: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-08T15:00:30Z'));
    const tx = {};
    lock = {
      runExclusive: jest.fn((_name, work: (t: object) => unknown) => work(tx)),
    };
    retirement = { retireDue: jest.fn().mockResolvedValue(1) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetirementScheduler,
        { provide: BatchLockService, useValue: lock },
        { provide: RetirementService, useValue: retirement },
      ],
    }).compile();
    scheduler = module.get(RetirementScheduler);
  });

  afterEach(() => jest.useRealTimers());

  it('staff-retire 락 안에서 한국 시간 오늘을 기준으로 퇴직을 확정한다', async () => {
    await scheduler.retireDue();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'staff-retire',
      expect.any(Function),
    );
    // UTC 10/08 15:00 은 한국 10/09 00:00 이다.
    expect(retirement.retireDue).toHaveBeenCalledWith(
      {},
      new Date('2026-10-09T00:00:00Z'),
    );
  });

  it('서울 시각 자정에 돈다 — 그래야 퇴직일 다음 날 0시에 퇴직이 확정된다', () => {
    // 키는 @nestjs/schedule 내부 상수(SCHEDULE_CRON_OPTIONS)다. 패키지가 export 하지 않는다.
    const handler = Object.getOwnPropertyDescriptor(
      RetirementScheduler.prototype,
      'retireDue',
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
