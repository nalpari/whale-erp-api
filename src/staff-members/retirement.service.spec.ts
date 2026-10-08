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
    staffMember: { findUnique: jest.Mock; update: jest.Mock };
    staffMemberRetirementLog: { create: jest.Mock; createMany: jest.Mock };
    contract: { findMany: jest.Mock };
    workSchedule: { count: jest.Mock };
    todoAssignee: { count: jest.Mock };
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
        update: jest.fn().mockResolvedValue({}),
      },
      staffMemberRetirementLog: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      contract: { findMany: jest.fn().mockResolvedValue([]) },
      workSchedule: { count: jest.fn().mockResolvedValue(0) },
      todoAssignee: { count: jest.fn().mockResolvedValue(0) },
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
    it.each([
      ['가입 전', { joinStatus: 'INVITED' }],
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

    it('판단 전에 직원 행을 잠근다', async () => {
      await service.retire(1, 2, date('2026-10-31'), now);

      const [strings] = prisma.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.staffMember.findUnique.mock.invocationCallOrder[0],
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
      await expect(
        service.preview(2, date('2026-10-31'), now),
      ).rejects.toBeInstanceOf(ConflictException);
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
