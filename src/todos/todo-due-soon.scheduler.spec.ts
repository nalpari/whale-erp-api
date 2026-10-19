import { CronExpression } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { BatchLockService } from '../batch/batch-lock.service';
import { TodoDueSoonScheduler } from './todo-due-soon.scheduler';
import { TodoDueSoonService } from './todo-due-soon.service';

describe('TodoDueSoonScheduler', () => {
  let scheduler: TodoDueSoonScheduler;
  let lock: { runExclusive: jest.Mock };
  let dueSoon: { notifyDueSoon: jest.Mock };

  beforeEach(async () => {
    const tx = {};
    lock = {
      runExclusive: jest.fn((_name, work: (t: object) => unknown) => work(tx)),
    };
    dueSoon = { notifyDueSoon: jest.fn().mockResolvedValue(2) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TodoDueSoonScheduler,
        { provide: BatchLockService, useValue: lock },
        { provide: TodoDueSoonService, useValue: dueSoon },
      ],
    }).compile();
    scheduler = module.get(TodoDueSoonScheduler);
  });

  it('todo-due-soon 락 안에서 수행 임박 알림을 만든다', async () => {
    await scheduler.notifyDueSoon();
    expect(lock.runExclusive).toHaveBeenCalledWith(
      'todo-due-soon',
      expect.any(Function),
    );
    expect(dueSoon.notifyDueSoon).toHaveBeenCalledWith({});
  });

  it('서울 시각으로 5분마다 돈다', () => {
    // 키는 @nestjs/schedule 내부 상수(SCHEDULE_CRON_OPTIONS)다. 패키지가 export 하지 않는다.
    const handler = Object.getOwnPropertyDescriptor(
      TodoDueSoonScheduler.prototype,
      'notifyDueSoon',
    )?.value as object;
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toMatchObject(
      { cronTime: CronExpression.EVERY_5_MINUTES, timeZone: 'Asia/Seoul' },
    );
  });
});
