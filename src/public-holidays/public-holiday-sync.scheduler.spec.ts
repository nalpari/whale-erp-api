import { Test } from '@nestjs/testing';
import { PublicHolidaySyncScheduler } from './public-holiday-sync.scheduler';
import { PublicHolidaySyncService } from './public-holiday-sync.service';

describe('PublicHolidaySyncScheduler', () => {
  it('올해 · 다음 해 동기화를 부른다', async () => {
    const sync = { syncAll: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        PublicHolidaySyncScheduler,
        { provide: PublicHolidaySyncService, useValue: sync },
      ],
    }).compile();

    await module.get(PublicHolidaySyncScheduler).synchronize();

    expect(sync.syncAll).toHaveBeenCalledTimes(1);
  });

  it('서울 시각 매월 1일 04:00 에 public-holiday-sync 이름으로 돈다', () => {
    // 키는 @nestjs/schedule 내부 상수(SCHEDULE_CRON_OPTIONS)다. 패키지가 export 하지 않는다.
    const handler = Object.getOwnPropertyDescriptor(
      PublicHolidaySyncScheduler.prototype,
      'synchronize',
    )?.value as object;

    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toMatchObject(
      {
        cronTime: '0 0 4 1 * *',
        timeZone: 'Asia/Seoul',
        name: 'public-holiday-sync',
      },
    );
  });
});
