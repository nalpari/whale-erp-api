import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { BatchLockService } from '../batch/batch-lock.service';
import { StorageService } from '../storage/storage.service';
import {
  CONTRACT_PURGE_SCAN_SIZE,
  ContractPurgeScheduler,
  ContractPurgeService,
  FILE_DELETE_BUDGET_MS,
} from './contract-purge';

type Locked = { id: number; staffMemberId: number };
type Doc = { storageKey: string; contract: { staffMemberId: number } };

const keys = new Map<number, string>();
const keyOf = (contractId: number) => {
  if (!keys.has(contractId))
    keys.set(contractId, StorageService.newKey('contracts', contractId, 'PDF'));
  return keys.get(contractId) as string;
};
const docOf = (contractId: number, staffMemberId: number): Doc => ({
  storageKey: keyOf(contractId),
  contract: { staffMemberId },
});
const badDoc = (staffMemberId: number): Doc => ({
  storageKey: `legacy/${staffMemberId}.pdf`,
  contract: { staffMemberId },
});

/**
 * $queryRaw 는 SQL 모양으로 가려 답한다 — 대상 고르기(staff 순서가 퇴직일 순, 첫 페이지 여부 · 앞 페이지 마지막 id 로 이어 읽기
 * · LIMIT) · 직원 잠금 · 계약 잠금 · 근무스케줄 잠금. 그 밖의 잠금은 빈 배열.
 */
const mockTx = ({
  staff = [1, 2],
  locked = [
    { id: 10, staffMemberId: 1 },
    { id: 11, staffMemberId: 1 },
    { id: 20, staffMemberId: 2 },
  ] as Locked[],
  skipped = 0,
  payslipStaff = [] as number[],
  documents = [docOf(10, 1), docOf(20, 2)],
  schedules = [{ id: 7, contractId: 10 }],
} = {}) => {
  const $queryRaw = jest.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('count(*)')) return Promise.resolve([{ skipped }]);
      if (sql.includes('ORDER BY s.retired_date')) {
        const [, first, , afterId, limit] = values as [
          Date,
          boolean,
          Date | null,
          number,
          number,
        ];
        const from = first ? 0 : staff.indexOf(afterId) + 1;
        return Promise.resolve(
          staff
            .slice(from, from + limit)
            .map((id) => ({ id, retiredDate: new Date('2020-01-01') })),
        );
      }
      if (sql.includes('FOR NO KEY UPDATE OF s')) {
        const [picked] = values as [number[]];
        return Promise.resolve(
          [...picked].sort((a, b) => a - b).map((id) => ({ id })),
        );
      }
      if (sql.includes('staff_member_id AS "staffMemberId" FROM contracts')) {
        const [ids] = values as [number[]];
        return Promise.resolve(
          locked.filter((c) => ids.includes(c.staffMemberId)),
        );
      }
      if (sql.includes('FROM work_schedules')) {
        const [ids] = values as [number[]];
        return Promise.resolve(
          schedules.filter((s) => ids.includes(s.contractId)),
        );
      }
      return Promise.resolve([]);
    },
  );
  type InWhere = { where: { contractId: { in: number[] } } };
  type DocWhere = {
    where: {
      contractId?: { in: number[] };
      contract?: { staffMemberId: { in: number[] } };
    };
  };
  return {
    $queryRaw,
    payslip: {
      findMany: jest.fn(({ where }: InWhere) =>
        Promise.resolve(
          locked
            .filter(
              (c) =>
                where.contractId.in.includes(c.id) &&
                payslipStaff.includes(c.staffMemberId),
            )
            .map((c) => ({ contract: { staffMemberId: c.staffMemberId } })),
        ),
      ),
    },
    contractDocument: {
      // 고르기는 직원 레코드로, 파일 삭제는 잠근 계약으로 찾는다
      findMany: jest.fn(({ where }: DocWhere) =>
        Promise.resolve(
          documents.filter((d) =>
            where.contract
              ? where.contract.staffMemberId.in.includes(
                  d.contract.staffMemberId,
                )
              : locked.some(
                  (c) =>
                    (where.contractId?.in ?? []).includes(c.id) &&
                    c.staffMemberId === d.contract.staffMemberId,
                ),
          ),
        ),
      ),
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
      deleteMany: jest.fn(({ where }: InWhere) =>
        Promise.resolve({ count: where.contractId.in.length }),
      ),
    },
    contractStatusHistory: { deleteMany: jest.fn() },
    contractParty: { deleteMany: jest.fn() },
    contractWorkDay: { deleteMany: jest.fn() },
  };
};
type Tx = ReturnType<typeof mockTx>;

const NOW = new Date('2026-11-04T03:00:00Z');

const sqlCalls = (tx: Tx) =>
  tx.$queryRaw.mock.calls.map(([strings, ...values]) => ({
    sql: strings.join('?'),
    values,
  }));
const picks = (tx: Tx) =>
  sqlCalls(tx).filter((c) => c.sql.includes('ORDER BY s.retired_date'));
const staffLock = (tx: Tx) =>
  sqlCalls(tx).filter((c) => c.sql.includes('FOR NO KEY UPDATE OF s'));
const deletedContracts = (tx: Tx) =>
  tx.contract.deleteMany.mock.calls.flatMap(([arg]) => arg.where.contractId.in);

describe('ContractPurgeService.purgeRetiredContracts', () => {
  const setup = (storage: Pick<StorageService, 'delete'> | null) =>
    new ContractPurgeService(storage as StorageService | null);
  const okStorage = () => ({ delete: jest.fn().mockResolvedValue(undefined) });
  const run = (service: ContractPurgeService, tx: Tx) =>
    service.purgeRetiredContracts(
      tx as unknown as Prisma.TransactionClient,
      NOW,
    );
  const silence = (service: ContractPurgeService) => {
    const logger = (
      service as unknown as {
        logger: { error: (m: string) => void; log: (m: string) => void };
      }
    ).logger;
    return {
      error: jest.spyOn(logger, 'error').mockImplementation(() => undefined),
      log: jest.spyOn(logger, 'log').mockImplementation(() => undefined),
    };
  };

  it('퇴직일 + 3년이 지난 퇴직 레코드를 퇴직일 순으로 고르고 한 번에 id 순으로 잠근 뒤, 파일 → 근무스케줄 · 알림 → 연결 비우기 → 딸린 행 → 계약 순으로 지운다', async () => {
    const storage = okStorage();
    const tx = mockTx();
    const count = await run(setup(storage), tx);

    const [pick] = picks(tx);
    expect(pick.sql).toContain("employment_status = 'RETIRED'");
    expect(pick.sql).toContain('retired_date <');
    expect(pick.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM contracts c JOIN payslips p',
    );
    expect(pick.sql).not.toContain('FOR ');
    expect(pick.values).toEqual([
      new Date('2023-11-04T00:00:00.000Z'),
      true,
      null,
      0,
      CONTRACT_PURGE_SCAN_SIZE,
    ]);
    // 잠금은 한 번, id 순 — 계약 등록(lockStaffForReplace)과 같은 순서
    const locks = staffLock(tx);
    expect(locks).toHaveLength(1);
    expect(locks[0].sql).toContain('ORDER BY s.staff_member_id');
    expect(locks[0].sql).toContain("employment_status = 'RETIRED'");
    // 계약을 가리키는 행도 파일을 지우기 전에 잠근다
    const calls = sqlCalls(tx);
    const lastLock = calls.findIndex((c) =>
      c.sql.includes('previous_contract_id = ANY'),
    );
    expect(calls[lastLock - 1].sql).toContain('staff_member_retirement_logs');
    expect(calls[lastLock - 2].sql).toContain('FROM work_schedules');
    expect(tx.$queryRaw.mock.invocationCallOrder[lastLock]).toBeLessThan(
      storage.delete.mock.invocationCallOrder[0],
    );

    expect(tx.contractDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contractId: { in: [10, 11, 20] } } }),
    );
    expect(storage.delete).toHaveBeenCalledWith(keyOf(10), {
      thumbnail: false,
    });
    expect(storage.delete).toHaveBeenCalledWith(keyOf(20), {
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
      data: { contractId: null, previousContractEndDate: null },
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

  it('잠근 뒤 급여명세서가 가리키는 계약이 보인 레코드는 통째로 건너뛰고 그 수를 남긴다', async () => {
    const storage = okStorage();
    const tx = mockTx({ payslipStaff: [1] });
    const service = setup(storage);
    const { log } = silence(service);
    await run(service, tx);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(keyOf(20), {
      thumbnail: false,
    });
    expect(deletedContracts(tx)).toEqual([20]);
    expect(log).toHaveBeenCalledWith(
      'contract purge SKIPPED_PAYSLIP_AFTER_LOCK staff=1',
    );
  });

  it('급여명세서 때문에 남은 레코드 수를 센다(대상 고르기에서는 처음부터 빠진다)', async () => {
    const tx = mockTx({ skipped: 2 });
    const service = setup(okStorage());
    const { log } = silence(service);
    await run(service, tx);
    expect(sqlCalls(tx)[0].sql).toContain('count(*)');
    expect(log).toHaveBeenCalledWith('contract purge SKIPPED_PAYSLIP staff=2');
  });

  it('파일을 지울 수 없을 레코드가 아무리 쌓여도 고를 때 빼고 뒤 퇴직자를 지운다 — 늘 실패하는 레코드가 창을 막지 않게', async () => {
    // 읽는 단위(500)를 넘겨 둘째 페이지까지 가야 지울 레코드가 나온다
    const n = CONTRACT_PURGE_SCAN_SIZE + 50;
    const unfit = Array.from({ length: n }, (_, i) => i + 1);
    const good = n + 1;
    const staff = [...unfit, good];
    const tx = mockTx({
      staff,
      locked: staff.map((id) => ({ id: id * 10, staffMemberId: id })),
      // 저장소 키 형식이 아닌 파일 — 늘 같은 이유로 실패한다
      documents: [...unfit.map(badDoc), docOf(good * 10, good)],
      schedules: [],
    });
    const storage = okStorage();
    const service = setup(storage);
    const { error } = silence(service);
    await expect(run(service, tx)).resolves.toBe(1);
    expect(deletedContracts(tx)).toEqual([good * 10]);
    // 형식이 아닌 키는 하나도 지우지 않는다 — 파일 일부만 지워진 채 남지 않게
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`SKIPPED_FILES staff=${n}`),
    );
    // 둘째 페이지는 첫 페이지 마지막 레코드 뒤부터 이어 읽고, 잠금은 고른 레코드만 한 번
    const [, second] = picks(tx);
    expect(second.values[1]).toBe(false);
    expect(second.values[3]).toBe(CONTRACT_PURGE_SCAN_SIZE);
    expect(staffLock(tx)).toHaveLength(1);
    expect(staffLock(tx)[0].values[0]).toEqual([good]);
  });

  it('한 레코드에 형식이 아닌 키가 하나라도 있으면 그 레코드는 고르지 않는다', async () => {
    const tx = mockTx({
      staff: [1],
      locked: [
        { id: 10, staffMemberId: 1 },
        { id: 11, staffMemberId: 1 },
      ],
      documents: [docOf(10, 1), badDoc(1)],
    });
    const storage = okStorage();
    const service = setup(storage);
    const { error } = silence(service);
    await expect(run(service, tx)).resolves.toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(staffLock(tx)).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('SKIPPED_FILES staff=1'),
    );
  });

  it('저장소 설정이 없으면 파일이 있는 레코드만 빼고 파일이 없는 레코드는 지운다', async () => {
    const tx = mockTx({ documents: [docOf(20, 2)] });
    const service = setup(null);
    const { error } = silence(service);
    await expect(run(service, tx)).resolves.toBe(2);
    expect(deletedContracts(tx)).toEqual([10, 11]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('SKIPPED_FILES staff=1'),
    );
  });

  it('파일 삭제가 실패한 레코드만 다음 날로 미루고 뒤 레코드는 지운다', async () => {
    const storage = {
      delete: jest
        .fn()
        .mockRejectedValueOnce(new Error('S3 down'))
        .mockResolvedValue(undefined),
    };
    const tx = mockTx();
    const service = setup(storage);
    silence(service);
    await run(service, tx);
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(deletedContracts(tx)).toEqual([20]);
    // 미룬 레코드의 계약에서 만든 근무스케줄(7 ← 10)은 남는다
    expect(tx.workSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('파일 삭제가 시간 상한을 넘으면 파일이 있는 남은 레코드는 다음 날로 미룬다', async () => {
    const clock = jest.spyOn(Date, 'now');
    // 시작 0 → 첫 레코드 0 → 둘째 레코드 상한 + 1
    clock
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(FILE_DELETE_BUDGET_MS + 1);
    const storage = okStorage();
    const tx = mockTx();
    const service = setup(storage);
    const { error } = silence(service);
    await run(service, tx);
    clock.mockRestore();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(deletedContracts(tx)).toEqual([10, 11]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('FILES_DEFERRED staff=2'),
    );
  });

  it('모든 레코드의 파일 삭제가 실패하면 아무 행도 지우지 않는다', async () => {
    const storage = { delete: jest.fn().mockRejectedValue(new Error('down')) };
    const tx = mockTx();
    const service = setup(storage);
    silence(service);
    await expect(run(service, tx)).resolves.toBe(0);
    expect(tx.contract.deleteMany).not.toHaveBeenCalled();
    expect(tx.notification.deleteMany).not.toHaveBeenCalled();
  });

  it('파일이 없는 레코드는 파일 삭제 없이 지운다', async () => {
    const storage = okStorage();
    const tx = mockTx({ documents: [] });
    await expect(run(setup(storage), tx)).resolves.toBe(3);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('파일은 퇴직일 순(고른 순서)으로 지운다 — 잠금만 id 순', async () => {
    const storage = okStorage();
    const tx = mockTx({ staff: [2, 1] });
    await run(setup(storage), tx);
    expect(storage.delete.mock.calls.map(([key]) => key as string)).toEqual([
      keyOf(20),
      keyOf(10),
    ]);
    expect(staffLock(tx)[0].values[0]).toEqual([2, 1]);
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
