import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkSchedulesService } from './work-schedules.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_CONSENT_VERSION,
} from '../admin-scope/hq-sharing';

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
  // 저장 알림은 work-schedule-notice.spec.ts 가 본다 — 여기선 점포가 없어 알림 없이 넘어간다
  store: { findUnique: jest.fn().mockResolvedValue(null) },
  workSchedule: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue({ storeId: 3 }),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(scheduleRow()),
    update: jest.fn().mockResolvedValue(scheduleRow()),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  workScheduleHistory: {
    create: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  },
  adminAccount: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn().mockResolvedValue([]),
  $executeRaw: jest.fn().mockResolvedValue(1),
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

      // 첫 조회는 주 잠금용 점포, 둘째가 판정 — 근무일 2026-10-21 을 덮는 체결 완료 계약을 찾는다
      expect(callArg(db.staffMember.findUnique, 1)).toMatchObject({
        where: { staffMemberId: 11 },
        select: {
          contracts: {
            // 한 번이라도 체결된 계약 — 체결 완료이거나 체결을 거쳐 종료된 것(PAY-11 v182 A안). 종료일이 빈 종료 계약은
            // 종료 처리한 날(ENDED 로 바뀐 시각의 한국 날짜)까지
            where: {
              startDate: { lte: d('2026-10-21') },
              OR: [
                { status: 'SIGNED', endDate: null },
                { status: 'SIGNED', endDate: { gte: d('2026-10-21') } },
                {
                  status: 'ENDED',
                  contractStatusHistories: { some: { toStatus: 'SIGNED' } },
                  endDate: { gte: d('2026-10-21') },
                },
                {
                  AND: [
                    {
                      status: 'ENDED',
                      contractStatusHistories: { some: { toStatus: 'SIGNED' } },
                      endDate: null,
                    },
                    {
                      contractStatusHistories: {
                        some: {
                          toStatus: 'ENDED',
                          changedAt: {
                            gte: new Date('2026-10-20T15:00:00.000Z'),
                          }, // 10-21 한국 0시
                        },
                      },
                    },
                  ],
                },
              ],
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

    it('폐점 점포 직원이면 400 WORK_SCHEDULE_STORE_CLOSED — 저장하지 않는다(WHALEERP-614)', async () => {
      db.store.findUnique.mockResolvedValueOnce({ storeStatusCode: 'CLOSED' });
      await expect(service.create(ADMIN, body)).rejects.toMatchObject({
        response: { code: 'WORK_SCHEDULE_STORE_CLOSED' },
      });
      expect(db.workSchedule.create).not.toHaveBeenCalled();
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
      // 계약 · 퇴직 판정 조회(contracts 를 읽는 staffFor)가 없다 — 알림이 계정만 읽는다
      expect(
        JSON.stringify(db.staffMember.findUnique.mock.calls),
      ).not.toContain('contracts');
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
          account: HQ_SHARING_CONSENTED.account,
        },
      });
    });

    it('범위 밖 점포는 404', async () => {
      await expect(
        service.assignableStaff(ADMIN, 99, '2026-10-21'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list (주간 · 월간 보기)', () => {
    it('가린 행끼리는 이름이 아니라 받을 수 있는 날짜로 줄 세운다', async () => {
      // 가맹 점포 4 · 둘 다 동의 안 함. 이름순은 가나(12) → 다라(13), 날짜순은 다라(21일부터) → 가나(22일만)
      db.staffMember.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ staffMemberId: 13 }])
        .mockResolvedValueOnce([{ staffMemberId: 12 }, { staffMemberId: 13 }])
        .mockResolvedValueOnce([
          {
            staffMemberId: 12,
            name: '가나',
            phone: '0101',
            jobTitle: '홀',
            employmentType: 'PART_TIME',
            account: null,
          },
          {
            staffMemberId: 13,
            name: '다라',
            phone: '0102',
            jobTitle: '홀',
            employmentType: 'PART_TIME',
            account: null,
          },
        ]);
      const res = await service.list(ADMIN, 4, '2026-10-21', '2026-10-22');
      expect(res.staff.map((r) => r.schedulableDates)).toEqual([
        ['2026-10-21', '2026-10-22'],
        ['2026-10-22'],
      ]);
      expect(res.staff.every((r) => r.isMasked && r.name === null)).toBe(true);
    });

    const at = (iso: string) => new Date(iso);

    it('기간이 42일을 넘거나 끝이 시작보다 앞이면 400, 범위 밖 점포는 404', async () => {
      await expect(
        service.list(ADMIN, 3, '2026-10-01', '2026-11-12'), // 43일
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.list(ADMIN, 3, '2026-10-21', '2026-10-20'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.list(ADMIN, 99, '2026-10-19', '2026-10-25'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.list(ADMIN, 3, '2026-10-01', '2026-11-11'), // 42일
      ).resolves.toBeDefined();
    });

    it('날마다 받을 수 있는 직원으로 행을 만들고, 동의 없는 가맹 직원은 가리되 인원에는 센다', async () => {
      // 가맹 점포 4 · BP 마스터. 21일: 11(동의) · 12(동의 안 함), 22일: 11 만
      db.staffMember.findMany
        .mockResolvedValueOnce([]) // 전날(20일) — 첫날 새벽 칸용
        .mockResolvedValueOnce([{ staffMemberId: 11 }, { staffMemberId: 12 }])
        .mockResolvedValueOnce([{ staffMemberId: 11 }])
        .mockResolvedValueOnce([
          {
            staffMemberId: 12,
            name: '가나',
            phone: '01011112222',
            jobTitle: '홀',
            employmentType: 'PART_TIME',
            account: { isHqSharingConsented: false },
          },
          {
            staffMemberId: 11,
            name: '다라',
            phone: '01033334444',
            jobTitle: '바리스타',
            employmentType: 'FULL_TIME',
            account: {
              isHqSharingConsented: true,
              hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
            },
          },
        ]);
      db.workSchedule.findMany.mockResolvedValue([
        // 21일 09:00-13:00 (11)
        scheduleRow({
          workScheduleId: 1,
          staffMemberId: 11,
          storeId: 4,
          startAt: at('2026-10-21T00:00:00Z'),
          endAt: at('2026-10-21T04:00:00Z'),
        }),
        // 21일 12:00-14:00 (12, 가림)
        scheduleRow({
          workScheduleId: 2,
          staffMemberId: 12,
          storeId: 4,
          startAt: at('2026-10-21T03:00:00Z'),
          endAt: at('2026-10-21T05:00:00Z'),
        }),
        // 22일 09:00-10:00 (12) — 22일엔 받을 수 없어 내지 않는다
        scheduleRow({
          workScheduleId: 3,
          staffMemberId: 12,
          storeId: 4,
          startAt: at('2026-10-22T00:00:00Z'),
          endAt: at('2026-10-22T01:00:00Z'),
        }),
      ]);

      const res = await service.list(ADMIN, 4, '2026-10-21', '2026-10-22');

      // 날마다 같은 판정으로 찾는다
      expect(callArg(db.staffMember.findMany, 0)).toMatchObject({
        where: { storeId: 4, joinStatus: 'JOINED' },
      });
      expect(res.staff).toEqual([
        {
          staffMemberId: 11,
          name: '다라',
          phoneLast4: '4444',
          jobTitle: '바리스타',
          employmentType: 'FULL_TIME',
          isMasked: false,
          schedulableDates: ['2026-10-21', '2026-10-22'],
        },
        {
          staffMemberId: null,
          name: null,
          phoneLast4: null,
          jobTitle: null,
          employmentType: null,
          isMasked: true,
          schedulableDates: ['2026-10-21'],
        },
      ]);
      expect(res.items.map((i) => i.workScheduleId)).toEqual([1]);
      expect(res.days[0]).toMatchObject({
        workDate: '2026-10-21',
        headcount: 2,
      });
      expect(res.days[0].coverage[18]).toBe(1); // 09:00
      expect(res.days[0].coverage[24]).toBe(2); // 12:00 — 가린 직원도 센다
      expect(res.days[1]).toMatchObject({
        workDate: '2026-10-22',
        headcount: 0,
      });
    });
  });

  describe('bulkCreate (#199)', () => {
    const rows = [
      {
        staffMemberId: 11,
        startTime: '09:00',
        endTime: '13:00',
        breakMinutes: 0,
      },
      {
        staffMemberId: 12,
        startTime: '09:00',
        endTime: '13:00',
        breakMinutes: 0,
      },
      {
        staffMemberId: 11,
        startTime: '17:00',
        endTime: '21:00',
        breakMinutes: 0,
      },
      {
        staffMemberId: 13,
        startTime: '09:00',
        endTime: '09:00',
        breakMinutes: 0,
      },
    ];

    it('줄마다 따로 저장하고 규칙에 걸린 줄만 실패로, 성공한 줄은 남긴다', async () => {
      // 12 는 계약이 없다
      db.staffMember.findUnique.mockImplementation(
        ({ where }: { where: { staffMemberId: number } }) =>
          Promise.resolve(
            where.staffMemberId === 12
              ? staffRow({ contracts: [] })
              : staffRow(),
          ),
      );
      let id = 100;
      db.workSchedule.create.mockImplementation(
        ({
          data,
        }: {
          data: { staffMemberId: number; startAt: Date; endAt: Date };
        }) =>
          Promise.resolve(scheduleRow({ ...data, workScheduleId: (id += 1) })),
      );

      const res = await service.bulkCreate(ADMIN, {
        workDate: '2026-10-21',
        rows,
      });

      expect(res.created.map((r) => r.workScheduleId)).toEqual([101, 102]);
      expect(res.failed).toEqual([
        {
          index: 1,
          staffMemberId: 12,
          statusCode: 400,
          code: 'WORK_SCHEDULE_NO_CONTRACT',
          message: '근무일에 체결 완료된 근로계약이 없는 직원입니다',
        },
        {
          index: 3,
          staffMemberId: 13,
          statusCode: 400,
          code: null,
          message: '시작과 종료가 같습니다 — 근무는 24시간보다 짧아야 합니다',
        },
      ]);
      // 줄마다 트랜잭션 + 직원(11)마다 알림 트랜잭션 하나
      expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    });

    it('업무 규칙이 아닌 오류도 그 줄만 실패(500)로 남기고 다음 줄 · 알림은 계속한다', async () => {
      let n = 0;
      db.workSchedule.create.mockImplementation(() =>
        (n += 1) === 2
          ? Promise.reject(new Error('db down'))
          : Promise.resolve(scheduleRow({ workScheduleId: 100 + n })),
      );
      const res = await service.bulkCreate(ADMIN, {
        workDate: '2026-10-21',
        rows: rows.slice(0, 3),
      });
      expect(res.created.map((r) => r.workScheduleId)).toEqual([101, 103]);
      expect(res.failed).toEqual([
        expect.objectContaining({
          index: 1,
          statusCode: 500,
          code: 'WORK_SCHEDULE_SAVE_FAILED',
        }),
      ]);
      // 줄 3 + 알림(직원 11) 1
      expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    });

    it('알림이 실패해도 저장한 줄은 그대로 돌려주고 로그만 남긴다', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      let call = 0;
      prisma.$transaction.mockImplementation(
        (work: (tx: typeof db) => unknown) =>
          (call += 1) === 2
            ? Promise.reject(new Error('notice down'))
            : work(db),
      );
      const res = await service.bulkCreate(ADMIN, {
        workDate: '2026-10-21',
        rows: rows.slice(0, 1),
      });
      expect(res.created).toHaveLength(1);
      expect(res.failed).toEqual([]);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('notice down'),
      );
      error.mockRestore();
    });
  });

  describe('copyLastWeek (#200)', () => {
    it('weekStart 가 월요일이 아니면 400, 범위 밖 점포는 404', async () => {
      await expect(
        service.copyLastWeek(ADMIN, 3, '2026-10-21', false),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.copyLastWeek(ADMIN, 99, '2026-10-19', false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('폐점 점포는 미리보기 · 복사 모두 400 WORK_SCHEDULE_STORE_CLOSED — 빈 주를 세기 전에(WHALEERP-614)', async () => {
      for (const apply of [false, true]) {
        db.store.findUnique.mockResolvedValueOnce({
          storeStatusCode: 'CLOSED',
        });
        await expect(
          service.copyLastWeek(ADMIN, 3, '2026-10-19', apply),
        ).rejects.toMatchObject({
          response: { code: 'WORK_SCHEDULE_STORE_CLOSED' },
        });
      }
      expect(db.workSchedule.count).not.toHaveBeenCalled();
    });

    it('넣을 주에 한 건이라도 있으면 409 WORK_SCHEDULE_WEEK_NOT_EMPTY', async () => {
      db.workSchedule.count.mockResolvedValue(1);
      await expect(
        service.copyLastWeek(ADMIN, 3, '2026-10-19', false),
      ).rejects.toMatchObject({
        response: { code: 'WORK_SCHEDULE_WEEK_NOT_EMPTY' },
      });
    });

    it('본사 계정은 원본 주에 가려진 직원이 있으면 미리보기 · 복사 모두 409 — 누구인지는 알리지 않는다(Q9)', async () => {
      db.workSchedule.findMany.mockResolvedValue([
        scheduleRow({
          storeId: 4,
          startAt: new Date('2026-10-12T00:00:00Z'),
          endAt: new Date('2026-10-12T04:00:00Z'),
        }),
      ]);
      db.staffMember.findMany.mockResolvedValue([
        {
          staffMemberId: 11,
          name: '다라',
          retiredDate: null,
          account: { isHqSharingConsented: false },
        },
      ]);
      for (const apply of [false, true])
        await expect(
          service.copyLastWeek(ADMIN, 4, '2026-10-19', apply),
        ).rejects.toMatchObject({
          response: {
            code: 'WORK_SCHEDULE_COPY_HIDDEN_STAFF',
            message: expect.not.stringContaining('다라') as unknown,
          },
        });
      expect(db.workSchedule.create).not.toHaveBeenCalled();
    });

    it('복사는 점포 · 주 advisory lock 을 잡고 원본 직원 행을 ID 순으로 잠근 뒤 넣는다', async () => {
      db.workSchedule.findMany.mockResolvedValue([
        scheduleRow({
          staffMemberId: 12,
          startAt: new Date('2026-10-12T00:00:00Z'),
          endAt: new Date('2026-10-12T04:00:00Z'),
        }),
        scheduleRow({
          staffMemberId: 11,
          startAt: new Date('2026-10-13T00:00:00Z'),
          endAt: new Date('2026-10-13T04:00:00Z'),
        }),
      ]);
      db.staffMember.findMany.mockResolvedValueOnce([
        { staffMemberId: 11, name: '가', retiredDate: null, account: null },
        { staffMemberId: 12, name: '나', retiredDate: null, account: null },
      ]);
      await service.copyLastWeek(ADMIN, 3, '2026-10-19', true);
      const lock = db.$executeRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(lock[0].join('?')).toContain('pg_advisory_xact_lock');
      expect(lock[1]).toBe('work-schedule-week:3:2026-10-19');
      const calls = db.$queryRaw.mock.calls as [TemplateStringsArray][];
      const rowLock = calls.find(([sql]) =>
        sql.join('?').includes('ORDER BY staff_member_id'),
      );
      expect(rowLock).toBeDefined();
    });

    it('한 건 등록은 넣을 주의 공유 잠금을 직원 행보다 먼저 잡는다(복사와 같은 키)', async () => {
      await service.create(ADMIN, body);
      const shared = (
        db.$executeRaw.mock.calls as [TemplateStringsArray, ...unknown[]][]
      )[0];
      expect(shared[0].join('?')).toContain('pg_advisory_xact_lock_shared');
      expect(shared[1]).toBe('work-schedule-week:3:2026-10-19'); // 2026-10-21(수)의 월요일
    });

    it('넣는 사이 동의가 철회돼 WORK_SCHEDULE_HIDDEN 이 나면 복사 전체를 409 로 막는다', async () => {
      // 가맹 점포 4 · BP 마스터. 미리 읽을 때는 동의했지만, 넣을 때 판정(staffFor)에서는 동의가 없다
      db.workSchedule.findMany.mockResolvedValue([
        scheduleRow({
          storeId: 4,
          startAt: new Date('2026-10-12T00:00:00Z'),
          endAt: new Date('2026-10-12T04:00:00Z'),
        }),
      ]);
      db.staffMember.findMany.mockResolvedValueOnce([
        {
          staffMemberId: 11,
          name: '다라',
          retiredDate: null,
          account: {
            isHqSharingConsented: true,
            hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          },
        },
      ]);
      db.staffMember.findUnique.mockResolvedValue(staffRow({ storeId: 4 }));
      await expect(
        service.copyLastWeek(ADMIN, 4, '2026-10-19', true),
      ).rejects.toMatchObject({
        response: { code: 'WORK_SCHEDULE_COPY_HIDDEN_STAFF' },
      });
    });

    it('제외는 날짜 단위로 모은다 — 같은 날 쪼갠 근무가 둘 다 빠져도 한 번', async () => {
      db.workSchedule.findMany.mockResolvedValue([
        scheduleRow({
          startAt: new Date('2026-10-12T00:00:00Z'),
          endAt: new Date('2026-10-12T04:00:00Z'),
        }),
        scheduleRow({
          workScheduleId: 71,
          startAt: new Date('2026-10-12T08:00:00Z'),
          endAt: new Date('2026-10-12T12:00:00Z'),
        }),
      ]);
      db.staffMember.findMany.mockResolvedValueOnce([
        { staffMemberId: 11, name: '다라', retiredDate: null, account: null },
      ]);
      db.staffMember.findUnique.mockResolvedValue(staffRow({ contracts: [] }));
      const res = await service.copyLastWeek(ADMIN, 3, '2026-10-19', false);
      expect(res.staff[0].excluded).toEqual([
        { workDate: '2026-10-19', code: 'WORK_SCHEDULE_NO_CONTRACT' },
      ]);
    });

    it('미리보기는 쓰지 않고 원본을 +7일로 판정한다 — 받을 수 없는 날은 제외 사유로', async () => {
      db.workSchedule.findMany.mockResolvedValue([
        scheduleRow({
          startAt: new Date('2026-10-12T00:00:00Z'),
          endAt: new Date('2026-10-12T04:00:00Z'),
          breakMinutes: 30,
        }),
      ]);
      db.staffMember.findMany.mockResolvedValueOnce([
        { staffMemberId: 11, name: '다라', retiredDate: null, account: null },
      ]);
      db.staffMember.findUnique.mockResolvedValue(staffRow({ contracts: [] }));

      const res = await service.copyLastWeek(ADMIN, 3, '2026-10-19', false);

      expect(db.workSchedule.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(res.staff).toEqual([
        expect.objectContaining({
          staffMemberId: 11,
          source: { days: 1, minutes: 210 },
          copied: { days: 0, minutes: 0 },
          excluded: [
            { workDate: '2026-10-19', code: 'WORK_SCHEDULE_NO_CONTRACT' },
          ],
        }),
      ]);
    });
  });

  describe('histories (#608)', () => {
    it('변경 전후 값을 근무일 · 시각 · 휴게로, 주체는 관리자 이름으로, 모양이 다른 값은 null', async () => {
      db.workScheduleHistory.count.mockResolvedValue(2);
      db.workScheduleHistory.findMany.mockResolvedValue([
        {
          workScheduleHistoryId: 2,
          workScheduleId: 70,
          changeType: 'UPDATED',
          beforeValue: {
            startAt: '2026-10-21T13:00:00.000Z',
            endAt: '2026-10-21T17:00:00.000Z',
            breakMinutes: 30,
          },
          afterValue: { broken: true },
          changedBy: ADMIN,
          changedAt: new Date('2026-10-21T05:00:00Z'),
          workSchedule: { staffMemberId: 11, staffMember: { name: '다라' } },
        },
      ]);
      db.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: ADMIN, name: '정하윤' },
      ]);

      const res = await service.histories(ADMIN, {
        storeId: 3,
        from: '2026-10-21',
        to: '2026-10-21',
        pageSize: 50,
        page: 2,
      });

      expect(res).toEqual({
        total: 2,
        items: [
          {
            workScheduleHistoryId: 2,
            workScheduleId: 70,
            changeType: 'UPDATED',
            changedAt: '2026-10-21T05:00:00.000Z',
            changedBy: { adminAccountId: ADMIN, name: '정하윤' },
            staffMemberId: 11,
            staffName: '다라',
            // 22:00~익일 02:00 은 시작한 날
            before: {
              workDate: '2026-10-21',
              startTime: '22:00',
              endTime: '02:00',
              breakMinutes: 30,
            },
            after: null,
          },
        ],
      });
      expect(callArg(db.workScheduleHistory.findMany, 0)).toMatchObject({
        where: {
          workSchedule: { storeId: 3 },
          changedAt: {
            gte: new Date('2026-10-20T15:00:00.000Z'),
            lt: new Date('2026-10-21T15:00:00.000Z'),
          },
        },
        skip: 50,
        take: 50,
      });
    });

    it('본사 계정이 가맹 점포를 보면 동의한 직원 이력만 · 가려진 직원을 필터로 고르면 404(Q12)', async () => {
      await service.histories(ADMIN, { storeId: 4 });
      expect(callArg(db.workScheduleHistory.count, 0)).toMatchObject({
        where: {
          workSchedule: {
            storeId: 4,
            staffMember: {
              account: HQ_SHARING_CONSENTED.account,
            },
          },
        },
      });
      db.staffMember.findUnique.mockResolvedValue({
        storeId: 4,
        account: { isHqSharingConsented: false },
      });
      await expect(
        service.histories(ADMIN, { storeId: 4, staffMemberId: 11 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // 없는 직원도 같은 404
      db.staffMember.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.histories(ADMIN, { storeId: 4, staffMemberId: 11 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // 다른 점포 직원도 404
      db.staffMember.findUnique.mockResolvedValue({
        storeId: 3,
        account: null,
      });
      await expect(
        service.histories(ADMIN, { storeId: 4, staffMemberId: 11 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('거꾸로 된 기간은 400', async () => {
      await expect(
        service.histories(ADMIN, {
          storeId: 3,
          from: '2026-10-22',
          to: '2026-10-21',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('범위 밖 점포는 404', async () => {
      await expect(
        service.histories(ADMIN, { storeId: 99 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
