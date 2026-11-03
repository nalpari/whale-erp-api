import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { BatchLockService } from '../batch/batch-lock.service';
import type { StorageService } from '../storage/storage.service';
import {
  ContractPurgeScheduler,
  ContractPurgeService,
  FILE_DELETE_BUDGET_MS,
} from './contract-purge';

type Locked = { id: number; staffMemberId: number };

const mockTx = ({
  staff = [1, 2],
  locked = [
    { id: 10, staffMemberId: 1 },
    { id: 11, staffMemberId: 1 },
    { id: 20, staffMemberId: 2 },
  ] as Locked[],
  skipped = 0,
  payslipStaff = [] as number[],
  documents = [
    { storageKey: 'contracts/10/a.pdf', contract: { staffMemberId: 1 } },
    { storageKey: 'contracts/20/b.pdf', contract: { staffMemberId: 2 } },
  ],
  schedules = [7],
} = {}) => {
  const $queryRaw = jest
    .fn()
    .mockResolvedValueOnce([{ skipped }])
    .mockResolvedValueOnce(staff.map((id) => ({ id })))
    .mockResolvedValueOnce(locked)
    .mockResolvedValueOnce(schedules.map((id) => ({ id })));
  return {
    $queryRaw,
    payslip: {
      findMany: jest.fn().mockResolvedValue(
        payslipStaff.map((staffMemberId) => ({
          contract: { staffMemberId },
        })),
      ),
    },
    contractDocument: {
      findMany: jest.fn().mockResolvedValue(documents),
      deleteMany: jest.fn(),
    },
    notificationDelivery: { deleteMany: jest.fn() },
    notificationRecipient: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    workScheduleHistory: { deleteMany: jest.fn() },
    workSchedule: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    staffMemberRetirementLog: { updateMany: jest.fn() },
    contract: {
      updateMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    contractStatusHistory: { deleteMany: jest.fn() },
    contractParty: { deleteMany: jest.fn() },
    contractWorkDay: { deleteMany: jest.fn() },
  };
};
type Tx = ReturnType<typeof mockTx>;

const NOW = new Date('2026-11-04T03:00:00Z');

describe('ContractPurgeService.purgeRetiredContracts', () => {
  const setup = (storage: Pick<StorageService, 'delete'> | null) =>
    new ContractPurgeService(storage as StorageService | null);
  const okStorage = () => ({ delete: jest.fn().mockResolvedValue(undefined) });
  const run = (service: ContractPurgeService, tx: Tx) =>
    service.purgeRetiredContracts(
      tx as unknown as Prisma.TransactionClient,
      NOW,
    );
  const sqlAt = (tx: Tx, i: number) =>
    (tx.$queryRaw.mock.calls[i] as [TemplateStringsArray])[0].join('?');

  it('퇴직일 + 3년이 지난 퇴직 레코드를 잠그고, 파일 → 근무스케줄 · 알림 → 연결 비우기 → 딸린 행 → 계약 순으로 지운다', async () => {
    const storage = okStorage();
    const tx = mockTx();
    const count = await run(setup(storage), tx);

    const staffCall = tx.$queryRaw.mock.calls[1] as unknown[];
    const staffSql = sqlAt(tx, 1);
    expect(staffSql).toContain("employment_status = 'RETIRED'");
    expect(staffSql).toContain('retired_date <');
    expect(staffSql).toContain(
      'NOT EXISTS (SELECT 1 FROM contracts c JOIN payslips p',
    );
    expect(staffSql).toContain('FOR NO KEY UPDATE OF s');
    expect(staffCall).toContainEqual(new Date('2023-11-04T00:00:00.000Z'));
    expect(staffCall).toContain(100);
    expect(sqlAt(tx, 2)).toContain('FOR UPDATE');
    expect(sqlAt(tx, 3)).toContain('source_contract_id');

    expect(storage.delete).toHaveBeenCalledWith('contracts/10/a.pdf', {
      thumbnail: false,
    });
    expect(storage.delete).toHaveBeenCalledWith('contracts/20/b.pdf', {
      thumbnail: false,
    });
    const ids = { in: [10, 11, 20] };
    expect(tx.workScheduleHistory.deleteMany).toHaveBeenCalledWith({
      where: { workScheduleId: { in: [7] } },
    });
    const notification = { relatedType: 'CONTRACT', relatedId: ids };
    expect(tx.notificationDelivery.deleteMany).toHaveBeenCalledWith({
      where: { notificationRecipient: { notification } },
    });
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({
      where: notification,
    });
    expect(tx.staffMemberRetirementLog.updateMany).toHaveBeenCalledWith({
      where: { contractId: ids },
      data: { contractId: null },
    });
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { previousContractId: ids },
      data: { previousContractId: null },
    });
    for (const m of [
      tx.contractDocument.deleteMany,
      tx.contractStatusHistory.deleteMany,
      tx.contractParty.deleteMany,
      tx.contractWorkDay.deleteMany,
      tx.contract.deleteMany,
    ])
      expect(m).toHaveBeenCalledWith({ where: { contractId: ids } });

    const order = [
      storage.delete,
      tx.workSchedule.deleteMany,
      tx.notification.deleteMany,
      tx.staffMemberRetirementLog.updateMany,
      tx.contract.updateMany,
      tx.contractDocument.deleteMany,
      tx.contract.deleteMany,
      // 근무스케줄 알림이 먼저 같은 메서드를 부른다 — 마지막 호출(근로계약 알림)로 본다
    ].map((m) => m.mock.invocationCallOrder.at(-1) ?? 0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(count).toBe(3);
  });

  it('잠근 뒤 급여명세서가 가리키는 계약이 보인 레코드는 통째로 건너뛴다', async () => {
    const storage = okStorage();
    const tx = mockTx({ payslipStaff: [1] });
    await run(setup(storage), tx);
    expect(tx.payslip.findMany).toHaveBeenCalledWith({
      where: { contractId: { in: [10, 11, 20] } },
      select: { contract: { select: { staffMemberId: true } } },
    });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('contracts/20/b.pdf', {
      thumbnail: false,
    });
    expect(tx.contract.deleteMany).toHaveBeenCalledWith({
      where: { contractId: { in: [20] } },
    });
  });

  it('급여명세서 때문에 남은 레코드 수를 센다(대상 쿼리에서는 처음부터 빠진다)', async () => {
    const tx = mockTx({ skipped: 2 });
    const service = setup(okStorage());
    const log = jest
      .spyOn(
        (service as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);
    await run(service, tx);
    expect(sqlAt(tx, 0)).toContain('count(*)');
    expect(log).toHaveBeenCalledWith('contract purge SKIPPED_PAYSLIP staff=2');
  });

  it('파일 삭제가 실패하면 그 레코드부터는 다음 날로 미루고 앞 레코드만 지운다', async () => {
    const storage = {
      delete: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('S3 down')),
    };
    const tx = mockTx();
    const service = setup(storage);
    jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    await run(service, tx);
    expect(tx.contract.deleteMany).toHaveBeenCalledWith({
      where: { contractId: { in: [10, 11] } },
    });
  });

  it('파일 삭제가 시간 상한을 넘으면 남은 레코드는 다음 날로 미룬다 — 느리기만 한 저장소로 60초를 넘기지 않게', async () => {
    const clock = jest.spyOn(Date, 'now');
    // 시작 0 → 첫 레코드 확인 0 → 둘째 레코드 확인 상한 + 1ms
    clock
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(FILE_DELETE_BUDGET_MS + 1);
    const storage = okStorage();
    const tx = mockTx();
    const service = setup(storage);
    const error = jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    await run(service, tx);
    clock.mockRestore();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(tx.contract.deleteMany).toHaveBeenCalledWith({
      where: { contractId: { in: [10, 11] } },
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('FILES_DEFERRED staff=2'),
    );
  });

  it('첫 레코드 파일부터 실패하면 아무 행도 지우지 않는다', async () => {
    const storage = { delete: jest.fn().mockRejectedValue(new Error('down')) };
    const tx = mockTx();
    const service = setup(storage);
    jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    await expect(run(service, tx)).resolves.toBe(0);
    expect(tx.contract.deleteMany).not.toHaveBeenCalled();
    expect(tx.notification.deleteMany).not.toHaveBeenCalled();
  });

  it('파일이 없는 레코드는 저장소 없이도 지운다', async () => {
    const tx = mockTx({ documents: [] });
    await expect(run(setup(null), tx)).resolves.toBe(3);
  });

  it('지울 레코드가 없으면 아무것도 바꾸지 않는다', async () => {
    const tx = mockTx({ staff: [] });
    await expect(run(setup(okStorage()), tx)).resolves.toBe(0);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.contract.deleteMany).not.toHaveBeenCalled();
  });
});

describe('ContractPurgeScheduler', () => {
  it('contract-purge 락 안에서, 서울 05:00 에 파기한다', async () => {
    const tx = {};
    const lock = {
      runExclusive: jest.fn(
        async (_name: string, work: (t: object) => Promise<number>) => ({
          ran: true,
          processed: await work(tx),
        }),
      ),
    };
    const purge = { purgeRetiredContracts: jest.fn().mockResolvedValue(0) };
    const module = await Test.createTestingModule({
      providers: [
        ContractPurgeScheduler,
        { provide: BatchLockService, useValue: lock },
        { provide: ContractPurgeService, useValue: purge },
      ],
    }).compile();

    await module.get(ContractPurgeScheduler).run();

    expect(lock.runExclusive).toHaveBeenCalledWith(
      'contract-purge',
      expect.any(Function),
    );
    expect(purge.purgeRetiredContracts).toHaveBeenCalledWith(tx);
    const handler = Object.getOwnPropertyDescriptor(
      ContractPurgeScheduler.prototype,
      'run',
    )?.value as object;
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler)).toMatchObject(
      {
        cronTime: '0 0 5 * * *',
        name: 'contract-purge',
        timeZone: 'Asia/Seoul',
      },
    );
  });
});
