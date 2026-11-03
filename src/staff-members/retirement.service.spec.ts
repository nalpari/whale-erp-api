import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RetirementService } from './retirement.service';

// 규칙의 경계만 목으로 본다. 여러 표에 걸친 정리(스케줄 · TO-DO · 계약)는 test/staff-retirement.e2e-spec.ts 가
// 실제 DB 로 본다. 이 파일은 DB 없이 `pnpm test` 에서 도는 회귀 그물이다.
describe('RetirementService', () => {
  // 한국 2026-10-08 12:00
  const now = new Date('2026-10-08T03:00:00Z');
  const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

  let service: RetirementService;
  /** 퇴직 확정(정리)은 e2e 가 본다. 여기서는 불렸는지만 본다. */
  let finalize: jest.SpyInstance;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    staffMember: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    contractStatusHistory: { findFirst: jest.Mock };
    staffMemberRetirementLog: { create: jest.Mock; createMany: jest.Mock };
    contract: { findMany: jest.Mock; count: jest.Mock };
    workSchedule: { count: jest.Mock };
    todoAssignee: { count: jest.Mock };
    attendanceRecord: { findFirst: jest.Mock };
  };

  const staff = (overrides: Record<string, unknown> = {}) => ({
    joinStatus: 'JOINED',
    employmentStatus: 'EMPLOYED',
    retiredDate: null,
    hiredDate: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
      staffMember: {
        findUnique: jest.fn().mockResolvedValue(staff()),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // 입사일 다시 채우기(refillHiredDate)가 찾는 체결 완료 이력 — 실제 채우기는 e2e 가 본다
      contractStatusHistory: { findFirst: jest.fn().mockResolvedValue(null) },
      staffMemberRetirementLog: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // 보낸(임시저장이 아닌) 계약 수 — 가입 전 레코드가 재직으로 세는지 본다
      contract: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
      },
      workSchedule: { count: jest.fn().mockResolvedValue(0) },
      todoAssignee: { count: jest.fn().mockResolvedValue(0) },
      attendanceRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    prisma.$transaction.mockImplementation((work: (tx: unknown) => unknown) =>
      work(prisma),
    );
    const module = await Test.createTestingModule({
      providers: [
        RetirementService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(RetirementService);
    finalize = jest
      .spyOn(
        service as unknown as { finalize: () => Promise<boolean> },
        'finalize',
      )
      .mockResolvedValue(true);
  });

  describe('퇴직일 범위', () => {
    it('정확히 3개월 전은 받고, 지난 날짜라 바로 확정한다', async () => {
      await expect(
        service.retire(1, 2, date('2026-07-08'), now),
      ).resolves.toBeUndefined();
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    it('3개월 하고 하루 전은 받지 않는다', async () => {
      await expect(
        service.retire(1, 2, date('2026-07-07'), now),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('미래 날짜는 상한 없이 받는다', async () => {
      await expect(
        service.retire(1, 2, date('2027-12-31'), now),
      ).resolves.toBeUndefined();
    });

    it('입사일과 같은 날은 받고, 앞선 날은 받지 않는다', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ hiredDate: date('2026-10-01') }),
      );

      await expect(
        service.retire(1, 2, date('2026-09-30'), now),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.retire(1, 2, date('2026-10-01'), now),
      ).resolves.toBeUndefined();
    });

    it('입사일이 아직 오지 않았으면(입사 전 퇴직) 입사일보다 앞선 날도 받는다 (WHALEERP-613, 2026-10-22 김민식)', async () => {
      // 시작일이 미래인 계약을 체결해 입사일이 11/01 로 찼지만, 오늘(10/08) 입사 전에 그만둔다
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ hiredDate: date('2026-11-01') }),
      );

      await expect(
        service.retire(1, 2, date('2026-10-08'), now),
      ).resolves.toBeUndefined();
    });

    it('한국 날짜로 오늘을 정한다 — UTC 로 전날이어도 한국이 다음 날이면 그날이 오늘이다', async () => {
      // UTC 10/07 15:30 = 한국 10/08 00:30. 한국 오늘은 10/08 이라 10/08 퇴직은 지난 날짜가 아니다.
      await service.retire(
        1,
        2,
        date('2026-10-08'),
        new Date('2026-10-07T15:30:00Z'),
      );

      expect(finalize).not.toHaveBeenCalled();
    });
  });

  describe('처리할 수 없는 레코드', () => {
    it('그 점포에 퇴근하지 않은 출근이 있으면 퇴직 처리 · 퇴직일 변경 모두 409 OPEN_CHECK_IN — 먼저 보정으로 닫는다(2026-10-27 재영)', async () => {
      prisma.attendanceRecord.findFirst.mockResolvedValue({
        recordedAt: new Date('2026-10-07T00:30:00Z'),
      });
      const r = await service
        .retire(1, 2, date('2026-10-31'), now)
        .catch((e: ConflictException) => e);
      expect(r).toBeInstanceOf(ConflictException);
      expect((r as ConflictException).getResponse()).toMatchObject({
        code: 'OPEN_CHECK_IN',
        message: expect.stringContaining(
          '10/07 09:30 퇴근하지 않은 출근이 있습니다',
        ) as unknown,
      });
      const where = (
        prisma.attendanceRecord.findFirst.mock.calls[0] as [
          { where: Record<string, unknown> },
        ]
      )[0].where;
      expect(where).toMatchObject({
        staffMemberId: 2,
        kind: 'CHECK_IN',
        attendanceRecordsAsCheckIn: { none: {} },
      });
      expect(prisma.staffMember.update).not.toHaveBeenCalled();
      expect(where.recordedAt).toEqual({ gte: expect.any(Date) as unknown });

      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ retiredDate: date('2026-10-31') }),
      );
      await expect(
        service.changeDate(1, 2, date('2026-11-15'), now),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.staffMemberRetirementLog.create).not.toHaveBeenCalled();
    });

    it('가입 전 레코드도 근로계약서를 받았으면 퇴직 처리한다 — 재직은 계약서를 받을 때부터(CTR-25, 2026-10-19 재영)', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ joinStatus: 'INVITED' }),
      );
      await expect(
        service.retire(1, 2, date('2026-10-31'), now),
      ).resolves.toBeUndefined();
      expect(prisma.contract.count).toHaveBeenCalledWith({
        where: { staffMemberId: 2, status: { not: 'DRAFT' } },
      });
    });

    it('가입한 직원은 계약을 세지 않는다', async () => {
      await service.retire(1, 2, date('2026-10-31'), now);
      expect(prisma.contract.count).not.toHaveBeenCalled();
    });

    it('임시저장 계약만 있는 가입 전 레코드는 재직으로 세지 않아 409', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ joinStatus: 'DRAFT' }),
      );
      prisma.contract.count.mockResolvedValue(0);
      await expect(
        service.retire(1, 2, date('2026-10-31'), now),
      ).rejects.toThrow('임시저장 근로계약만 있는 직원은');
      expect(prisma.staffMember.update).not.toHaveBeenCalled();
    });

    it.each([
      [
        '이미 퇴직',
        { employmentStatus: 'RETIRED', retiredDate: date('2026-09-01') },
      ],
      ['이미 퇴직 예정', { retiredDate: date('2026-10-20') }],
    ])('%s 이면 409', async (_, overrides) => {
      prisma.staffMember.findUnique.mockResolvedValue(staff(overrides));

      await expect(
        service.retire(1, 2, date('2026-10-31'), now),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.staffMember.update).not.toHaveBeenCalled();
    });

    it('없는 직원이면 404', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(null);

      await expect(
        service.retire(1, 2, date('2026-10-31'), now),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('판단 전에 직원 행(FOR NO KEY UPDATE) → 계정 행 순으로 잠근다 — 생년월일 정정 · 세무 정보와 같은 순서, 직원 출근의 외래키 잠금과 부딪히지 않게', async () => {
      prisma.staffMember.findUnique
        .mockResolvedValueOnce({ accountId: 77 })
        .mockResolvedValue(staff());
      await service.retire(1, 2, date('2026-10-31'), now);

      const sql = (i: number) =>
        (prisma.$queryRaw.mock.calls[i] as [string[]])[0].join('?');
      expect(sql(0)).toContain('staff_members');
      expect(sql(0)).toContain('FOR NO KEY UPDATE');
      expect(sql(1)).toContain('accounts');
      expect(sql(1)).toContain('FOR UPDATE');
      // 판단에 쓰는 직원 읽기(두 번째)는 두 잠금 뒤다
      expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        prisma.staffMember.findUnique.mock.invocationCallOrder[1],
      );
    });
  });

  describe('취소 · 변경', () => {
    const scheduled = (retiredDate: string) =>
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ retiredDate: date(retiredDate) }),
      );

    it('퇴직일이 내일이면 취소할 수 있다', async () => {
      scheduled('2026-10-09');

      await expect(service.cancel(1, 2, now)).resolves.toBeUndefined();
    });

    it('퇴직일이 오늘이면 409 — 퇴직일 전날까지만', async () => {
      scheduled('2026-10-08');

      await expect(service.cancel(1, 2, now)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        service.changeDate(1, 2, date('2026-10-20'), now),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('같은 날짜로 바꾸면 409 이고 로그를 남기지 않는다', async () => {
      scheduled('2026-10-20');

      await expect(
        service.changeDate(1, 2, date('2026-10-20'), now),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.staffMemberRetirementLog.create).not.toHaveBeenCalled();
    });

    it('퇴직 예정이 아니면 409', async () => {
      await expect(service.cancel(1, 2, now)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('확정(finalize)', () => {
    it('이미 나간 가입 초대를 무효로 한다 — 퇴직한 뒤 그 링크로 가입 · 날인하지 않게(CTR-25)', async () => {
      finalize.mockRestore();
      const tx = {
        staffMember: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        workSchedule: {
          updateManyAndReturn: jest.fn().mockResolvedValue([]),
        },
        todoAssignee: { findMany: jest.fn().mockResolvedValue([]) },
        invitation: { updateMany: jest.fn() },
        contract: { updateManyAndReturn: jest.fn().mockResolvedValue([]) },
        contractStatusHistory: { createMany: jest.fn() },
      };
      await expect(
        (
          service as unknown as {
            finalize: (...a: unknown[]) => Promise<boolean>;
          }
        ).finalize(tx, 2, date('2026-10-07'), { actor: 'SYSTEM' }),
      ).resolves.toBe(true);
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 2, status: 'SENT' },
        data: { status: 'EXPIRED' },
      });
    });
  });

  describe('점포 폐점 일괄 퇴직 retireAllForStoreClosing (WHALEERP-646)', () => {
    const closed = date('2026-10-08');
    const run = () =>
      service.retireAllForStoreClosing(prisma as never, [10], 1, closed, now);
    /** 직원 id 별로 잠근 뒤 읽는 값을 정한다. */
    const members = (byId: Record<number, Record<string, unknown>>) => {
      prisma.staffMember.findMany.mockResolvedValue(
        Object.keys(byId).map((id) => ({ staffMemberId: Number(id) })),
      );
      prisma.staffMember.findUnique.mockImplementation(
        ({ where }: { where: { staffMemberId: number } }) =>
          Promise.resolve(staff(byId[where.staffMemberId])),
      );
    };

    it('직원이 없으면 0명이다', async () => {
      await expect(run()).resolves.toEqual({ retired: 0, skipped: 0 });
      expect(finalize).not.toHaveBeenCalled();
    });

    it('그 점포 직원만 고른다 — 직원 id 오름차순', async () => {
      await run();

      expect(prisma.staffMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: { in: [10] }, employmentStatus: 'EMPLOYED' },
          orderBy: { staffMemberId: 'asc' },
        }),
      );
    });

    it('EMPLOYED 직원만 조회하고, 계정 행은 잠그지 않는다 — 직원 행만 FOR NO KEY UPDATE', async () => {
      members({ 2: { accountId: 77 } });

      await run();

      expect(prisma.staffMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: { in: [10] }, employmentStatus: 'EMPLOYED' },
        }),
      );
      const queries = (prisma.$queryRaw.mock.calls as [string[]][]).map(
        ([strings]) => strings.join('?'),
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('staff_members');
      expect(queries[0]).toContain('FOR NO KEY UPDATE');
      expect(queries.join()).not.toContain('accounts');
    });

    it('여러 점포를 한 번에 받는다 — 중복 id 는 한 번만, 빈 배열이면 아무것도 하지 않는다', async () => {
      await expect(
        service.retireAllForStoreClosing(prisma as never, [], 1, closed, now),
      ).resolves.toEqual({ retired: 0, skipped: 0 });
      expect(prisma.staffMember.findMany).not.toHaveBeenCalled();

      await service.retireAllForStoreClosing(
        prisma as never,
        [12, 10, 12],
        1,
        closed,
        now,
      );

      expect(prisma.staffMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId: { in: [12, 10] },
            employmentStatus: 'EMPLOYED',
          },
          orderBy: { staffMemberId: 'asc' },
        }),
      );
    });

    it('폐점일에 시각이 섞여 들어와도 한국 날짜(00:00Z)로 맞춘다', async () => {
      members({ 2: {} });

      // UTC 10/07 16:30 = 한국 10/08 01:30
      await service.retireAllForStoreClosing(
        prisma as never,
        [10],
        1,
        new Date('2026-10-07T16:30:00Z'),
        now,
      );

      expect(prisma.staffMember.update).toHaveBeenCalledWith({
        where: { staffMemberId: 2 },
        data: { retiredDate: closed },
      });
      expect(finalize).toHaveBeenCalledWith(
        prisma,
        2,
        closed,
        expect.anything(),
      );
    });

    it('skipped 는 잠근 뒤 퇴직이었거나 임시저장만 있는 가입 전이라 건너뛴 수 + 확정이 false 인 수다', async () => {
      members({
        2: { employmentStatus: 'RETIRED' },
        3: { joinStatus: 'DRAFT' },
        4: {},
        5: {},
      });
      prisma.contract.count.mockImplementation(
        ({ where }: { where: { staffMemberId: number } }) =>
          Promise.resolve(where.staffMemberId === 3 ? 0 : 1),
      );
      finalize.mockImplementation((_tx, id: number) =>
        Promise.resolve(id !== 5),
      );

      await expect(run()).resolves.toEqual({ retired: 1, skipped: 3 });
    });

    it('열린 출근을 검사하지 않는다 (2026-11-03)', async () => {
      members({ 2: {} });

      await run();

      expect(prisma.attendanceRecord.findFirst).not.toHaveBeenCalled();
    });

    it('퇴직일이 없으면 폐점일로 저장하고 RETIRE 로그를 남긴 뒤 폐점일로 바로 확정한다', async () => {
      members({ 2: {} });

      await expect(run()).resolves.toEqual({ retired: 1, skipped: 0 });

      expect(prisma.staffMember.update).toHaveBeenCalledWith({
        where: { staffMemberId: 2 },
        data: { retiredDate: closed },
      });
      expect(prisma.staffMemberRetirementLog.create).not.toHaveBeenCalled();
      expect(prisma.staffMemberRetirementLog.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            action: 'RETIRE',
            retiredDate: closed,
            processedBy: 1,
            processedAt: now,
          }),
        ],
      });
      expect(finalize).toHaveBeenCalledWith(prisma, 2, closed, {
        actor: 'ADMIN',
        adminAccountId: 1,
      });
    });

    it('퇴직일이 폐점일보다 뒤면 앞당긴다 — CANCEL(옛 날짜) + RETIRE(폐점일), 처리 시각 같음', async () => {
      members({ 2: { retiredDate: date('2026-10-20') } });

      await run();

      expect(prisma.staffMemberRetirementLog.create).toHaveBeenCalledWith({
        data: {
          staffMemberId: 2,
          action: 'CANCEL',
          retiredDate: date('2026-10-20'),
          processedBy: 1,
          processedAt: now,
        },
      });
      expect(prisma.staffMemberRetirementLog.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            action: 'RETIRE',
            retiredDate: closed,
            processedAt: now,
          }),
        ],
      });
      expect(finalize).toHaveBeenCalledWith(
        prisma,
        2,
        closed,
        expect.anything(),
      );
    });

    it.each(['2026-10-08', '2026-10-01'])(
      '퇴직일이 폐점일 이전 · 같은 날(%s)이면 그대로 두고 그 퇴직일로 확정한다',
      async (iso) => {
        members({ 2: { retiredDate: date(iso) } });

        await run();

        expect(prisma.staffMember.update).not.toHaveBeenCalled();
        expect(prisma.staffMemberRetirementLog.create).not.toHaveBeenCalled();
        expect(
          prisma.staffMemberRetirementLog.createMany,
        ).not.toHaveBeenCalled();
        expect(finalize).toHaveBeenCalledWith(
          prisma,
          2,
          date(iso),
          expect.anything(),
        );
      },
    );

    it('입사일이 폐점일보다 미래여도 폐점일로 처리한다 (WHALEERP-613)', async () => {
      members({ 2: { hiredDate: date('2026-11-01') } });

      await expect(run()).resolves.toEqual({ retired: 1, skipped: 0 });
      expect(finalize).toHaveBeenCalledWith(
        prisma,
        2,
        closed,
        expect.anything(),
      );
    });

    it('이미 퇴직한 직원과 임시저장 계약만 있는 가입 전 레코드는 건너뛴다 — 예외 없이', async () => {
      members({
        2: { employmentStatus: 'RETIRED', retiredDate: date('2026-09-01') },
        3: { joinStatus: 'DRAFT' },
        4: {},
      });
      // 보낸 계약 수: 3번(가입 전)만 0
      prisma.contract.count.mockImplementation(
        ({ where }: { where: { staffMemberId: number } }) =>
          Promise.resolve(where.staffMemberId === 3 ? 0 : 1),
      );

      await expect(run()).resolves.toEqual({ retired: 1, skipped: 2 });

      expect(finalize).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledWith(
        prisma,
        4,
        closed,
        expect.anything(),
      );
    });

    it('확정이 실패하면 삼키지 않고 던진다 — 폐점 트랜잭션째 되돌아가게', async () => {
      members({ 2: {} });
      finalize.mockRejectedValue(new Error('boom'));

      await expect(run()).rejects.toThrow('boom');
    });
  });

  describe('배치 retireDue', () => {
    const due = (...ids: number[]) => {
      const tx = {
        staffMember: {
          findMany: jest.fn().mockResolvedValue(
            ids.map((staffMemberId) => ({
              staffMemberId,
              retiredDate: date('2026-10-07'),
            })),
          ),
        },
      };
      return tx as unknown as Parameters<RetirementService['retireDue']>[0];
    };

    it('직원마다 따로 연 트랜잭션에서 확정한다 — 배치 락의 트랜잭션으로는 대상만 고른다', async () => {
      await service.retireDue(due(3, 4), date('2026-10-08'));

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(finalize).toHaveBeenCalledTimes(2);
    });

    it('한 명이 실패해도 다음 직원으로 넘어가고, 실패를 직원 ID 와 함께 남긴다', async () => {
      finalize
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(true);
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(
        service.retireDue(due(3, 4), date('2026-10-08')),
      ).resolves.toBe(1);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('staffMemberId=3'),
        expect.anything(),
      );
      logged.mockRestore();
    });

    it('이미 누가 확정했으면 세지 않는다', async () => {
      finalize.mockResolvedValue(false);

      await expect(service.retireDue(due(3), date('2026-10-08'))).resolves.toBe(
        0,
      );
    });
  });

  describe('미리 보기', () => {
    it('처리와 같은 날짜 · 상태 검사를 한다', async () => {
      await expect(
        service.preview(2, date('2026-07-07'), now),
      ).rejects.toBeInstanceOf(BadRequestException);

      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ joinStatus: 'DRAFT' }),
      );
      prisma.contract.count.mockResolvedValue(0);
      await expect(
        service.preview(2, date('2026-10-31'), now),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('임시저장 계약도 종료될 계약으로 센다 — 퇴직자에게 이어 쓴 계약서가 가지 않게 (2026-10-12 재영)', async () => {
      prisma.contract.findMany.mockResolvedValue([
        { contractId: 7, status: 'DRAFT' },
      ]);

      await expect(
        service.preview(2, date('2026-10-31'), now),
      ).resolves.toMatchObject({
        contractsToEnd: [{ contractId: 7, status: 'DRAFT' }],
      });
      expect(prisma.contract.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            staffMemberId: 2,
            status: {
              in: [
                'DRAFT',
                'PENDING_SEND',
                'PENDING_SIGNATURE',
                'CORRECTION_REQUESTED',
              ],
            },
          },
        }),
      );
    });

    it('퇴직 예정인 레코드도 볼 수 있다 — 퇴직일 변경 확인창에 쓴다', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(
        staff({ retiredDate: date('2026-10-20') }),
      );

      await expect(
        service.preview(2, date('2026-10-31'), now),
      ).resolves.toEqual({
        schedulesToRemove: 0,
        todosToUnassign: 0,
        contractsToEnd: [],
      });
    });
  });
});
