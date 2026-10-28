import { CronExpression } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { BatchLockService } from '../batch/batch-lock.service';
import { ExcelExportsScheduler } from './excel-exports.scheduler';
import { ExcelExportsService } from './excel-exports.service';

describe('ExcelExportsScheduler', () => {
  const setup = async () => {
    const tx = {};
    const lock = {
      runExclusive: jest.fn((_name, work: (t: object) => unknown) => work(tx)),
    };
    const exports = {
      processPending: jest.fn().mockResolvedValue(0),
      purgeExpired: jest.fn().mockResolvedValue(3),
      deleteExpiredFiles: jest.fn().mockResolvedValue(2),
    };
    const module = await Test.createTestingModule({
      providers: [
        ExcelExportsScheduler,
        { provide: BatchLockService, useValue: lock },
        { provide: ExcelExportsService, useValue: exports },
      ],
    }).compile();
    return { scheduler: module.get(ExcelExportsScheduler), lock, exports, tx };
  };
  const cronOf = (method: 'processPending' | 'purge') =>
    Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      Object.getOwnPropertyDescriptor(ExcelExportsScheduler.prototype, method)
        ?.value as object,
    ) as object;

  it('1분마다 예약 생성을 처리한다 — 행 잠금(SKIP LOCKED)으로 나눠 가지므로 배치 락은 쓰지 않는다', async () => {
    const { scheduler, lock, exports } = await setup();
    await scheduler.processPending();
    expect(exports.processPending).toHaveBeenCalledTimes(1);
    expect(lock.runExclusive).not.toHaveBeenCalled();
    // 앞 실행이 끝나기 전에 다음 분이 오면 건너뛴다 — 겹쳐 돌면 멈춘 작업 정리가 도는 작업을 빼앗는다.
    expect(cronOf('processPending')).toMatchObject({
      cronTime: CronExpression.EVERY_MINUTE,
      timeZone: 'Asia/Seoul',
      name: 'excel-export',
      waitForCompletion: true,
    });
  });

  it('매일 04:30 에 excel-download-purge 락 안에서 2년 지난 이력을 지우고, 기한이 지난 S3 파일을 지운다', async () => {
    const { scheduler, lock, exports, tx } = await setup();
    await scheduler.purge();
    expect(lock.runExclusive).toHaveBeenCalledWith(
      'excel-download-purge',
      expect.any(Function),
    );
    expect(exports.purgeExpired).toHaveBeenCalledWith(tx);
    // S3 삭제는 락 트랜잭션(60초) 밖이다 — 파일이 많으면 트랜잭션 시간을 넘긴다.
    expect(exports.deleteExpiredFiles).toHaveBeenCalledTimes(1);
    expect(
      exports.deleteExpiredFiles.mock.invocationCallOrder[0],
    ).toBeGreaterThan(lock.runExclusive.mock.invocationCallOrder[0]);
    expect(cronOf('purge')).toMatchObject({
      cronTime: '0 30 4 * * *',
      timeZone: 'Asia/Seoul',
      name: 'excel-download-purge',
    });
  });
});
