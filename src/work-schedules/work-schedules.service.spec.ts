import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkSchedulesService } from './work-schedules.service';

const ADMIN = 9;
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
/** 그 호출의 첫 인자 — Prisma 호출 하나({ where, select, data })를 본다 */
const callArg = (mock: jest.Mock, i: number) =>
  (mock.mock.calls[i] as [unknown])[0];

/** 직원 레코드 읽기(staffFor) 한 행 */
const staffRow = (patch: Record<string, unknown> = {}) => ({
  storeId: 3,
  retiredDate: null,
  joinStatus: 'JOINED',
  account: { isHqSharingConsented: false },
  contracts: [{ contractId: 50 }],
  ...patch,
});

const scheduleRow = (patch: Record<string, unknown> = {}) => ({
  workScheduleId: 70,
  staffMemberId: 11,
  storeId: 3,
  startAt: new Date('2026-10-21T00:00:00.000Z'),
  endAt: new Date('2026-10-21T09:00:00.000Z'),
  breakMinutes: 60,
  ...patch,
});

const mockDb = () => ({
  staffMember: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(staffRow()),
  },
  contractWorkDay: { findUnique: jest.fn().mockResolvedValue(null) },
  workSchedule: {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(scheduleRow()),
    update: jest.fn().mockResolvedValue(scheduleRow()),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  workScheduleHistory: { create: jest.fn() },
  $queryRaw: jest.fn().mockResolvedValue([]),
});

describe('WorkSchedulesService', () => {
  let service: WorkSchedulesService;
  let db: ReturnType<typeof mockDb>;
  let prisma: ReturnType<typeof mockDb> & { $transaction: jest.Mock };
  let scope: { getManageableStores: jest.Mock };

  beforeEach(async () => {
    db = mockDb();
    prisma = {
      ...db,
      $transaction: jest.fn((work: (tx: typeof db) => unknown) => work(db)),
    };
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 3, storeTypeCode: 'DIRECT' },
          { storeId: 4, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkSchedulesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(WorkSchedulesService);
  });

  const body = {
    staffMemberId: 11,
    workDate: '2026-10-21',
    startTime: '22:00',
    endTime: '06:00',
    breakMinutes: 30,
  };

  describe('create', () => {
    it('자정 넘김을 받고, 근무일을 덮는 계약을 기본값 계약으로 남기고, 등록 이력을 쓴다', async () => {
      await service.create(ADMIN, body);

      // 근무일 2026-10-21 을 덮는 체결 완료 계약을 찾는다
      expect(callArg(db.staffMember.findUnique, 0)).toMatchObject({
        where: { staffMemberId: 11 },
        select: {
          contracts: {
            // 한 번이라도 체결된 계약 — 지금 체결 완료이거나 체결을 거쳐 종료된 것(PAY-11 v181 A안)
            where: {
              AND: [
                {
                  OR: [
                    { status: 'SIGNED' },
                    {
                      status: 'ENDED',
                      contractStatusHistories: { some: { toStatus: 'SIGNED' } },
                    },
                  ],
                },
                {
                  OR: [
                    { endDate: null },
                    { endDate: { gte: d('2026-10-21') } },
                  ],
                },
              ],
              startDate: { lte: d('2026-10-21') },
            },
          },
        },
      });
      expect(db.$queryRaw).toHaveBeenCalled(); // 직원 행 잠금
      expect(db.workSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            staffMemberId: 11,
            storeId: 3,
            startAt: new Date('2026-10-21T13:00:00.000Z'), // 22:00 KST
            endAt: new Date('2026-10-21T21:00:00.000Z'), // 다음 날 06:00 KST
            breakMinutes: 30,
            sourceContractId: 50,
            createdBy: ADMIN,
          },
        }),
      );
      expect(callArg(db.workScheduleHistory.create, 0)).toMatchObject({
        data: { workScheduleId: 70, changeType: 'CREATED', changedBy: ADMIN },
      });
    });

    it('근무일에 체결 완료 계약이 없으면 400 WORK_SCHEDULE_NO_CONTRACT', async () => {
      db.staffMember.findUnique.mockResolvedValue(staffRow({ contracts: [] }));
      await expect(service.create(ADMIN, body)).rejects.toMatchObject({
        response: { code: 'WORK_SCHEDULE_NO_CONTRACT' },
      });
      expect(db.workSchedule.create).not.toHaveBeenCalled();
    });

    it('가입 전이면 400 WORK_SCHEDULE_NOT_JOINED(종이 계약 체결 완료여도)', async () => {
      db.staffMember.findUnique.mockResolvedValue(
        staffRow({ joinStatus: 'INVITED' }),
      );
      await expect(service.create(ADMIN, body)).rejects.toMatchObject({
        response: { code: 'WORK_SCHEDULE_NOT_JOINED' },
      });
    });

    it('퇴직일 뒤 날짜는 400, 퇴직일 당일은 받는다(CTR-24)', async () => {
      db.staffMember.findUnique.mockResolvedValue(
        staffRow({ retiredDate: d('2026-10-20') }),
      );
      await expect(service.create(ADMIN, body)).rejects.toMatchObject({
        response: { code: 'WORK_SCHEDULE_AFTER_RETIREMENT' },
      });
      db.staffMember.findUnique.mockResolvedValue(
        staffRow({ retiredDate: d('2026-10-21') }),
      );
      await expect(service.create(ADMIN, body)).resolves.toBeDefined();
    });

    it('업무 범위 밖 직원은 404', async () => {
      db.staffMember.findUnique.mockResolvedValue(staffRow({ storeId: 99 }));
      await expect(service.create(ADMIN, body)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('본사 계정 · 가맹 점포 · 동의 없는 직원은 400, 직영은 동의와 상관없다(ATT-30)', async () => {
      db.staffMember.findUnique.mockResolvedValue(staffRow({ storeId: 4 }));
      await expect(service.create(ADMIN, body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      db.staffMember.findUnique.mockResolvedValue(staffRow({ storeId: 3 }));
      await expect(service.create(ADMIN, body)).resolves.toBeDefined();
    });

    it('같은 직원 근무스케줄과 겹치면 409 — 맞닿는 것은 겹치지 않는 조건으로 찾는다', async () => {
      db.workSchedule.findFirst.mockResolvedValue({ workScheduleId: 1 });
      await expect(service.create(ADMIN, body)).rejects.toMatchObject({
        response: { code: 'WORK_SCHEDULE_OVERLAP' },
      });
      expect(callArg(db.workSchedule.findFirst, 0)).toMatchObject({
        where: {
          staffMemberId: 11,
          isDeleted: false,
          startAt: { lt: new Date('2026-10-21T21:00:00.000Z') },
          endAt: { gt: new Date('2026-10-21T13:00:00.000Z') },
        },
      });
    });

    it('동시 저장이 DB 겹침 금지에 걸려도 같은 409', async () => {
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientUnknownRequestError(
          'conflicting key value violates exclusion constraint "work_schedules_no_overlap"',
          { clientVersion: 'test' },
        ),
      );
      await expect(service.create(ADMIN, body)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('24시간짜리 · 휴게가 근무 길이 이상이면 DB 에 묻기 전에 400', async () => {
      await expect(
        service.create(ADMIN, { ...body, endTime: '22:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create(ADMIN, { ...body, breakMinutes: 480 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('바뀐 근무일로 계약 · 겹침을 다시 보고(자기 자신은 빼고), 변경 전후 이력을 쓴다', async () => {
      db.$queryRaw.mockResolvedValue([
        {
          start_at: new Date('2026-10-21T00:00:00.000Z'),
          end_at: new Date('2026-10-21T09:00:00.000Z'),
          break_minutes: 60,
        },
      ]);
      db.workSchedule.findFirst
        .mockResolvedValueOnce({
          ...scheduleRow(),
          staffMember: { account: null },
        })
        .mockResolvedValueOnce(null);
      db.workSchedule.update.mockResolvedValue(
        scheduleRow({
          startAt: new Date('2026-10-22T00:00:00.000Z'),
          endAt: new Date('2026-10-22T08:00:00.000Z'),
          breakMinutes: 0,
        }),
      );

      await expect(
        service.update(ADMIN, 70, {
          workDate: '2026-10-22',
          startTime: '09:00',
          endTime: '17:00',
          breakMinutes: 0,
        }),
      ).resolves.toMatchObject({
        workDate: '2026-10-22',
        startTime: '09:00',
        endTime: '17:00',
      });
      expect(callArg(db.staffMember.findUnique, 0)).toMatchObject({
        where: { staffMemberId: 11 },
      });
      expect(callArg(db.workSchedule.findFirst, 1)).toMatchObject({
        where: { workScheduleId: { not: 70 } },
      });
      expect(db.workScheduleHistory.create).toHaveBeenCalledWith({
        data: {
          workScheduleId: 70,
          changeType: 'UPDATED',
          beforeValue: {
            startAt: '2026-10-21T00:00:00.000Z',
            endAt: '2026-10-21T09:00:00.000Z',
            breakMinutes: 60,
          },
          afterValue: {
            startAt: '2026-10-22T00:00:00.000Z',
            endAt: '2026-10-22T08:00:00.000Z',
            breakMinutes: 0,
          },
          changedBy: ADMIN,
        },
      });
    });

    it('없거나 범위 밖이면 404', async () => {
      await expect(
        service.update(ADMIN, 70, { ...body }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('계약 · 퇴직 조건 없이 지우고 삭제 이력을 쓴다', async () => {
      db.$queryRaw.mockResolvedValue([
        {
          start_at: new Date('2026-10-21T00:00:00.000Z'),
          end_at: new Date('2026-10-21T09:00:00.000Z'),
          break_minutes: 60,
        },
      ]);
      db.workSchedule.findFirst.mockResolvedValue({
        ...scheduleRow(),
        staffMember: { account: null },
      });
      await expect(service.remove(ADMIN, 70)).resolves.toEqual({
        workScheduleId: 70,
      });
      expect(db.staffMember.findUnique).not.toHaveBeenCalled();
      expect(callArg(db.workScheduleHistory.create, 0)).toMatchObject({
        data: { changeType: 'DELETED' },
      });
    });

    it('잠그고 다시 읽었을 때 그사이 지워졌으면 404 — 쓰지 않는다', async () => {
      db.workSchedule.findFirst.mockResolvedValue({
        ...scheduleRow(),
        staffMember: { account: null },
      });
      await expect(service.remove(ADMIN, 70)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.workSchedule.update).not.toHaveBeenCalled();
      expect(db.workScheduleHistory.create).not.toHaveBeenCalled();
    });

    it('본사에게 가려지는 가맹 직원 것은 404', async () => {
      db.workSchedule.findFirst.mockResolvedValue({
        ...scheduleRow({ storeId: 4 }),
        staffMember: { account: { isHqSharingConsented: false } },
      });
      await expect(service.remove(ADMIN, 70)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('defaults', () => {
    it('근무일 요일의 계약 근무시간, 휴게는 길이(분)로', async () => {
      db.contractWorkDay.findUnique.mockResolvedValue({
        startTime: t('09:00'),
        endTime: t('18:00'),
        breakStartTime: t('12:00'),
        breakEndTime: t('13:00'),
      });
      await expect(service.defaults(ADMIN, 11, '2026-10-21')).resolves.toEqual({
        startTime: '09:00',
        endTime: '18:00',
        breakMinutes: 60,
      });
      expect(db.contractWorkDay.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contractId_weekday: { contractId: 50, weekday: 'WED' } },
        }),
      );
    });

    it('계약 근무일이 아닌 요일은 빈 값', async () => {
      await expect(service.defaults(ADMIN, 11, '2026-10-25')).resolves.toEqual({
        startTime: null,
        endTime: null,
        breakMinutes: null,
      });
    });
  });

  describe('assignableStaff', () => {
    it('근무일을 덮는 계약 · 퇴직일 조건으로, 본사가 가맹 점포를 보면 동의한 직원만', async () => {
      await service.assignableStaff(ADMIN, 4, '2026-10-21');
      expect(callArg(db.staffMember.findMany, 0)).toMatchObject({
        where: {
          storeId: 4,
          joinStatus: 'JOINED',
          OR: [
            { retiredDate: null },
            { retiredDate: { gte: d('2026-10-21') } },
          ],
          account: { is: { isHqSharingConsented: true } },
        },
      });
    });

    it('범위 밖 점포는 404', async () => {
      await expect(
        service.assignableStaff(ADMIN, 99, '2026-10-21'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
