import { CronExpression } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { BatchLockService } from '../batch/batch-lock.service';
import { LeadPurgeScheduler } from './lead-purge.scheduler';
import { LeadsService } from './leads.service';

describe('LeadPurgeScheduler', () => {
  it('lead-purge 락 안에서 기간이 지난 도입문의를 파기한다', async () => {
    const tx = {};
    const lock = {
      runExclusive: jest.fn((_name, work: (t: object) => unknown) => work(tx)),
    };
    const leads = { purgeExpired: jest.fn().mockResolvedValue(1) };
    const module = await Test.createTestingModule({
      providers: [
        LeadPurgeScheduler,
        { provide: BatchLockService, useValue: lock },
        { provide: LeadsService, useValue: leads },
      ],
    }).compile();

    await module.get(LeadPurgeScheduler).purge();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'lead-purge',
      expect.any(Function),
    );
    expect(leads.purgeExpired).toHaveBeenCalledWith(tx);
  });

  it('서울 시각 자정에 lead-purge 이름으로 돈다', () => {
    // 키는 @nestjs/schedule 내부 상수(SCHEDULE_CRON_OPTIONS)다. 패키지가 export 하지 않는다.
    const handler = Object.getOwnPropertyDescriptor(
      LeadPurgeScheduler.prototype,
      'purge',
    )?.value as object;

    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toMatchObject(
      {
        cronTime: CronExpression.EVERY_DAY_AT_MIDNIGHT,
        timeZone: 'Asia/Seoul',
        name: 'lead-purge',
      },
    );
  });
});
