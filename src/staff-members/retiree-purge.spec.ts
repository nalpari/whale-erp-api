import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { BatchLockService } from '../batch/batch-lock.service';
import {
  RetireePurgeScheduler,
  purgeRetiredAccountChanges,
  purgeRetiredTaxProfiles,
  retiredBefore,
} from './retiree-purge';

describe('retiredBefore', () => {
  it('퇴직일 + 3년 당일까지 남고 다음 날 지운다 — 퇴직일이 이 날짜 앞이면 대상', () => {
    // 한국 2026-11-03 → 2023-11-03 앞(2023-11-02 까지) 퇴직이 대상. 2023-11-03 퇴직은 오늘이 + 3년 당일이라 남는다
    expect(retiredBefore(new Date('2026-11-03T03:00:00Z'))).toEqual(
      new Date('2023-11-03T00:00:00.000Z'),
    );
    // 다음 날이면 2023-11-03 퇴직도 대상
    expect(retiredBefore(new Date('2026-11-04T03:00:00Z'))).toEqual(
      new Date('2023-11-04T00:00:00.000Z'),
    );
  });

  it('한국 자정 직후(UTC 로는 전날)에도 한국 날짜로 센다', () => {
    expect(retiredBefore(new Date('2026-11-03T15:30:00Z'))).toEqual(
      new Date('2023-11-04T00:00:00.000Z'),
    );
  });

  it('2월 29일 퇴직은 3년 뒤 2월 28일까지 남는다', () => {
    expect(retiredBefore(new Date('2027-02-28T03:00:00Z'))).toEqual(
      new Date('2024-02-28T00:00:00.000Z'),
    );
    expect(retiredBefore(new Date('2027-03-01T03:00:00Z'))).toEqual(
      new Date('2024-03-01T00:00:00.000Z'),
    );
  });

  it('윤년 2월 29일에는 3년 전 2월 28일 퇴직도 대상이다 — 하루 늦게 지우지 않는다', () => {
    // 2025-02-28 퇴직은 + 3년 = 2028-02-28 이라 그다음 날(2028-02-29)에 지운다
    expect(retiredBefore(new Date('2028-02-28T03:00:00Z'))).toEqual(
      new Date('2025-02-28T00:00:00.000Z'),
    );
    expect(retiredBefore(new Date('2028-02-29T03:00:00Z'))).toEqual(
      new Date('2025-03-01T00:00:00.000Z'),
    );
    // 한국 2월 29일 0시 30분(UTC 로는 2월 28일)도 같다 — 한국 날짜로 센 뒤 보정한다
    expect(retiredBefore(new Date('2028-02-28T15:30:00Z'))).toEqual(
      new Date('2025-03-01T00:00:00.000Z'),
    );
    // 2025-03-01 퇴직은 2028-03-01 당일까지 남는다 — 3월 1일 기준은 그대로
    expect(retiredBefore(new Date('2028-03-01T03:00:00Z'))).toEqual(
      new Date('2025-03-01T00:00:00.000Z'),
    );
  });
});

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

describe('purgeRetiredTaxProfiles', () => {
  const mockTx = (ids: number[] = [3, 8]) => ({
    $queryRaw: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    staffTaxProfileHistory: { deleteMany: jest.fn() },
    staffTaxProfile: { deleteMany: jest.fn() },
  });
  const run = (tx: ReturnType<typeof mockTx>, now: Date) =>
    purgeRetiredTaxProfiles(tx as unknown as Prisma.TransactionClient, now);

  it('퇴직(RETIRED) 레코드 중 퇴직일 + 3년이 지난 것을 잠그고 이력 → 신고 정보 순으로 지운다', async () => {
    const tx = mockTx();
    const count = await run(tx, new Date('2026-11-04T03:00:00Z'));
    const call = tx.$queryRaw.mock.calls[0] as unknown[];
    const sql = sqlOf(call);
    expect(sql).toContain("employment_status = 'RETIRED'");
    expect(sql).toContain('retired_date <');
    expect(sql).toContain('FOR NO KEY UPDATE');
    // 퇴직일 순으로 고르고 id 순으로 잠근다 — 계약 등록(lockStaffForReplace)과 같은 잠금 순서(api #238 리뷰)
    expect(sql).toContain('ORDER BY t.retired_date, t.staff_member_id');
    expect(sql).toMatch(/ORDER BY s\.staff_member_id\s+FOR NO KEY UPDATE OF s/);
    expect(call).toContainEqual(new Date('2023-11-04T00:00:00.000Z'));
    expect(call).toContain(5000);
    const where = { where: { staffMemberId: { in: [3, 8] } } };
    expect(tx.staffTaxProfileHistory.deleteMany).toHaveBeenCalledWith(where);
    expect(tx.staffTaxProfile.deleteMany).toHaveBeenCalledWith(where);
    expect(
      tx.staffTaxProfileHistory.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.staffTaxProfile.deleteMany.mock.invocationCallOrder[0]);
    expect(count).toBe(2);
  });

  it('지울 것이 없으면 아무것도 지우지 않는다', async () => {
    const tx = mockTx([]);
    await expect(run(tx, new Date('2026-11-04T03:00:00Z'))).resolves.toBe(0);
    expect(tx.staffTaxProfile.deleteMany).not.toHaveBeenCalled();
  });
});

describe('purgeRetiredAccountChanges', () => {
  const mockTx = (ids: number[] = [11]) => ({
    $queryRaw: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    accountChangeHistory: {
      deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
    },
  });
  const run = (tx: ReturnType<typeof mockTx>, now: Date) =>
    purgeRetiredAccountChanges(tx as unknown as Prisma.TransactionClient, now);

  it('소속이 모두 퇴직하고 가장 늦은 퇴직일 + 3년이 지난 계정의 휴대전화번호 · 주소 이력만 지운다', async () => {
    const tx = mockTx();
    const count = await run(tx, new Date('2026-11-04T03:00:00Z'));
    const call = tx.$queryRaw.mock.calls[0] as unknown[];
    const sql = sqlOf(call);
    // 소속이 하나는 있고, 퇴직이 아니거나 퇴직일이 기준 이후인 소속은 없다
    expect(sql).toContain('EXISTS (SELECT 1 FROM staff_members');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM staff_members');
    expect(sql).toContain('field::text IN (');
    expect(sql).toContain('FOR UPDATE');
    expect(call).toContainEqual(new Date('2023-11-04T00:00:00.000Z'));
    expect(tx.accountChangeHistory.deleteMany).toHaveBeenCalledWith({
      where: {
        accountId: { in: [11] },
        field: { in: ['PHONE', 'ADDRESS'] },
        // 잠근 뒤 새 스냅샷으로 소속 조건을 다시 본다 — 그사이 생긴 재직 소속이 있으면 빠진다
        account: {
          staffMembers: {
            none: {
              OR: [
                { employmentStatus: { not: 'RETIRED' } },
                { retiredDate: null },
                { retiredDate: { gte: new Date('2023-11-04T00:00:00.000Z') } },
              ],
            },
          },
        },
      },
    });
    expect(count).toBe(4);
  });

  it('지울 것이 없으면 아무것도 지우지 않는다', async () => {
    const tx = mockTx([]);
    await expect(run(tx, new Date('2026-11-04T03:00:00Z'))).resolves.toBe(0);
    expect(tx.accountChangeHistory.deleteMany).not.toHaveBeenCalled();
  });
});

describe('RetireePurgeScheduler', () => {
  const setup = async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const lock = {
      runExclusive: jest.fn(
        async (_name: string, work: (t: object) => Promise<number>) => ({
          ran: true,
          processed: await work(tx),
        }),
      ),
    };
    const module = await Test.createTestingModule({
      providers: [
        RetireePurgeScheduler,
        { provide: BatchLockService, useValue: lock },
      ],
    }).compile();
    return { scheduler: module.get(RetireePurgeScheduler), lock, tx };
  };
  const cronOf = (method: string) =>
    Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      Object.getOwnPropertyDescriptor(RetireePurgeScheduler.prototype, method)
        ?.value as object,
    ) as unknown;

  it('신고 정보는 tax-profile-purge 락 안에서, 서울 05:10 에 지운다', async () => {
    const { scheduler, lock, tx } = await setup();
    await scheduler.purgeTaxProfiles();
    expect(lock.runExclusive).toHaveBeenCalledWith(
      'tax-profile-purge',
      expect.any(Function),
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(cronOf('purgeTaxProfiles')).toMatchObject({
      cronTime: '0 10 5 * * *',
      name: 'tax-profile-purge',
      timeZone: 'Asia/Seoul',
    });
  });

  it('계정 변경 이력은 account-change-purge 락 안에서, 서울 05:20 에 지운다', async () => {
    const { scheduler, lock, tx } = await setup();
    await scheduler.purgeAccountChanges();
    expect(lock.runExclusive).toHaveBeenCalledWith(
      'account-change-purge',
      expect.any(Function),
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(cronOf('purgeAccountChanges')).toMatchObject({
      cronTime: '0 20 5 * * *',
      name: 'account-change-purge',
      timeZone: 'Asia/Seoul',
    });
  });
});
