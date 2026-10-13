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
});
