import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstDayStart, kstToday } from '../src/staff-members/kst-date';
import { RetirementService } from '../src/staff-members/retirement.service';

// 퇴직 처리(WHALEERP-584)를 실제 DB 로 확인한다. 계약은 바꾸지 않고, 퇴직일 다음 날 배치(retireDue)가
// 상태를 바꾸며 스케줄 · 개인 TO-DO 배정 · 대기 계약을 정리한다는 규칙이 여러 표에 걸쳐 있어 목으로는
// 증명되지 않는다.
describe('퇴직 처리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let retirement: RetirementService;

  const today = kstToday();
  const day = (offset: number) => addDays(today, offset);
  /** 그 날짜 한국 10시에 시작하는 4시간 근무. */
  const shiftOn = (date: Date) => {
    const startAt = new Date(kstDayStart(date).getTime() + 10 * 3_600_000);
    return { startAt, endAt: new Date(startAt.getTime() + 4 * 3_600_000) };
  };

  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  /** 같은 BP 의 다른 점포만 관리하는 관리자 */
  let otherStoreAdminId: number;
  /** 이 점포를 매핑으로 관리하는 관리자 */
  let mappedAdminId: number;
  let otherStoreId: number;
  const staffIds: number[] = [];
  const accountIds: number[] = [];

  beforeAll(async () => {
    // 이 파일은 DB 전체에 퇴직 배치(retireDue)를 돌린다. 환경 없이 돌면 ConfigModule 이 .env.local, 곧 공용
    // 개발 DB 를 읽어 다른 사람의 퇴직 예정자를 퇴직시킨다. 일회용 DB 를 명시해야만 돈다.
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    retirement = app.get(RetirementService);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '퇴직 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '퇴직 테스트 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `retire${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ storeId: otherStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${(n + 1) % 1_000_000}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '다른 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const partialAdmin = (loginId: string, mappedStoreId: number) =>
      prisma.adminAccount.create({
        data: {
          loginId,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode: 'BA',
          roleGroupId: roleGroup.roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: false,
          accountStatusCode: 'ACTIVE',
          storeMappings: { create: { storeId: mappedStoreId } },
        },
      });
    ({ adminAccountId: otherStoreAdminId } = await partialAdmin(
      `other${n}`,
      otherStoreId,
    ));
    ({ adminAccountId: mappedAdminId } = await partialAdmin(
      `mapped${n}`,
      storeId,
    ));
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    await prisma.staffMemberRetirementLog.deleteMany({ where: byStaff });
    await prisma.contractStatusHistory.deleteMany({
      where: { contract: byStaff },
    });
    await prisma.contract.deleteMany({ where: byStaff });
    await prisma.workScheduleHistory.deleteMany({
      where: { workSchedule: byStaff },
    });
    await prisma.workSchedule.deleteMany({ where: byStaff });
    const todos = await prisma.todo.findMany({
      where: { storeId },
      select: { todoId: true },
    });
    const todoIds = todos.map((t) => t.todoId);
    await prisma.todoStatusHistory.deleteMany({
      where: { todoId: { in: todoIds } },
    });
    await prisma.todoAssignee.deleteMany({
      where: { todoId: { in: todoIds } },
    });
    await prisma.todo.deleteMany({ where: { todoId: { in: todoIds } } });
    await prisma.staffMember.deleteMany({ where: byStaff });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    const adminIds = [adminId, otherStoreAdminId, mappedAdminId];
    await prisma.adminStoreMapping.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [storeId, otherStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  async function createStaff(
    joinStatus: 'DRAFT' | 'INVITED' | 'JOINED' = 'JOINED',
    hiredDate: Date | null = null,
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    let accountId: number | null = null;
    if (joinStatus === 'JOINED') {
      ({ accountId } = await prisma.account.create({
        data: {
          email: `retire-${n}@test.invalid`,
          passwordHash: '!',
          realName: '홍길동',
          birthDate: new Date('1990-01-01'),
          phone: `010${n}`,
          status: 'JOINED',
        },
      }));
      accountIds.push(accountId);
    }
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name: '홍길동',
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus,
        hiredDate,
      },
    });
    staffIds.push(staff.staffMemberId);
    return staff.staffMemberId;
  }

  const contractOf = (
    staffMemberId: number,
    status: 'SIGNED' | 'PENDING_SEND' | 'PENDING_SIGNATURE',
    startDate: Date,
    endDate: Date | null,
  ) =>
    prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate,
        endDate,
        workTerms: {},
        wageTerms: {},
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status,
        createdBy: adminId,
      },
    });

  const scheduleOn = (staffMemberId: number, date: Date) =>
    prisma.workSchedule.create({
      data: {
        staffMemberId,
        storeId,
        ...shiftOn(date),
        breakMinutes: 0,
        confirmStatus: 'CONFIRMED',
        createdBy: adminId,
      },
    });

  async function personalTodo(staffMemberId: number, isCompleted = false) {
    const todo = await prisma.todo.create({
      data: {
        storeId,
        title: '재고 확인',
        assigneeType: 'INDIVIDUAL',
        executionMode: 'EACH',
        dueDate: day(10),
        status: isCompleted ? 'DONE' : 'PENDING',
        createdBy: adminId,
      },
    });
    await prisma.todoAssignee.create({
      data: { todoId: todo.todoId, staffMemberId, isCompleted },
    });
    return todo.todoId;
  }

  const staffOf = (staffMemberId: number) =>
    prisma.staffMember.findUniqueOrThrow({ where: { staffMemberId } });
  const scheduleHistoriesOf = (workScheduleId: number) =>
    prisma.workScheduleHistory.findMany({ where: { workScheduleId } });
  const logsOf = (staffMemberId: number) =>
    prisma.staffMemberRetirementLog.findMany({
      where: { staffMemberId },
      orderBy: { staffMemberRetirementLogId: 'asc' },
    });

  describe('처리', () => {
    it('미래 퇴직일이면 퇴직일만 저장하고 재직으로 둔다 — 계약 · 스케줄 · TO-DO 는 그대로', async () => {
      const staffId = await createStaff();
      const signed = await contractOf(staffId, 'SIGNED', day(-30), day(60));
      const pending = await contractOf(
        staffId,
        'PENDING_SIGNATURE',
        day(61),
        null,
      );
      const after = await scheduleOn(staffId, day(11));
      const todoId = await personalTodo(staffId);

      await retirement.retire(adminId, staffId, day(10));

      const staff = await staffOf(staffId);
      expect(staff.employmentStatus).toBe('EMPLOYED');
      expect(staff.retiredDate).toEqual(day(10));
      const contracts = await prisma.contract.findMany({
        where: { contractId: { in: [signed.contractId, pending.contractId] } },
        orderBy: { contractId: 'asc' },
      });
      expect(contracts.map((c) => [c.status, c.endDate])).toEqual([
        ['SIGNED', day(60)],
        ['PENDING_SIGNATURE', null],
      ]);
      expect(
        (
          await prisma.workSchedule.findUniqueOrThrow({
            where: { workScheduleId: after.workScheduleId },
          })
        ).isDeleted,
      ).toBe(false);
      expect(
        await prisma.todoAssignee.count({
          where: { todoId, staffMemberId: staffId },
        }),
      ).toBe(1);
    });

    it('퇴직일에 걸친 체결 완료 계약마다 그 시점 계약 종료일을 로그에 남긴다', async () => {
      const staffId = await createStaff();
      const spanning = await contractOf(staffId, 'SIGNED', day(-30), day(60));
      const open = await contractOf(staffId, 'SIGNED', day(-90), null);
      await contractOf(staffId, 'SIGNED', day(-200), day(-100)); // 이미 끝난 계약
      await contractOf(staffId, 'SIGNED', day(20), day(80)); // 퇴직일 뒤에 시작

      await retirement.retire(adminId, staffId, day(10));

      const logs = await logsOf(staffId);
      expect(
        logs.map((l) => [
          l.action,
          l.retiredDate,
          l.contractId,
          l.previousContractEndDate,
          l.processedBy,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['RETIRE', day(10), spanning.contractId, day(60), adminId],
          ['RETIRE', day(10), open.contractId, null, adminId],
        ]),
      );
      expect(logs).toHaveLength(2);
      expect(new Set(logs.map((l) => l.processedAt.getTime())).size).toBe(1);
    });

    it('걸친 계약이 없으면 계약 칸이 빈 한 줄만 남긴다', async () => {
      const staffId = await createStaff();

      await retirement.retire(adminId, staffId, day(10));

      const logs = await logsOf(staffId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ action: 'RETIRE', contractId: null });
    });

    it('오늘을 퇴직일로 처리해도 오늘까지는 재직이다', async () => {
      const staffId = await createStaff();

      await retirement.retire(adminId, staffId, day(0));

      expect((await staffOf(staffId)).employmentStatus).toBe('EMPLOYED');
    });

    it('지난 날짜면 그 자리에서 정리하고 퇴직으로 바꾼다', async () => {
      const staffId = await createStaff();
      const before = await scheduleOn(staffId, day(-5));
      const after = await scheduleOn(staffId, day(-4));
      const pending = await contractOf(staffId, 'PENDING_SEND', day(1), null);
      const todoId = await personalTodo(staffId);

      await retirement.retire(adminId, staffId, day(-5));

      expect(await staffOf(staffId)).toMatchObject({
        employmentStatus: 'RETIRED',
        retiredDate: day(-5),
      });
      const schedules = await prisma.workSchedule.findMany({
        where: {
          workScheduleId: { in: [before.workScheduleId, after.workScheduleId] },
        },
        orderBy: { workScheduleId: 'asc' },
      });
      expect(schedules.map((s) => s.isDeleted)).toEqual([false, true]);
      // 지운 스케줄마다 삭제 이력을 남긴다 — 화면의 변경 이력에서 이유 없이 사라지지 않게.
      expect(await scheduleHistoriesOf(after.workScheduleId)).toEqual([
        expect.objectContaining({ changeType: 'DELETED', changedBy: adminId }),
      ]);
      expect(await scheduleHistoriesOf(before.workScheduleId)).toEqual([]);
      expect(
        (
          await prisma.contract.findUniqueOrThrow({
            where: { contractId: pending.contractId },
          })
        ).status,
      ).toBe('ENDED');
      expect(
        await prisma.contractStatusHistory.findFirst({
          where: { contractId: pending.contractId },
        }),
      ).toMatchObject({
        fromStatus: 'PENDING_SEND',
        toStatus: 'ENDED',
        actor: 'ADMIN',
      });
      expect(await prisma.todoAssignee.count({ where: { todoId } })).toBe(0);
      expect(
        await prisma.todoStatusHistory.findFirst({ where: { todoId } }),
      ).toMatchObject({ unassignedStaffMemberId: staffId, changedBy: adminId });
    });

    it('3개월보다 오래된 날짜는 받지 않는다', async () => {
      const staffId = await createStaff();

      await expect(
        retirement.retire(adminId, staffId, day(-100)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('입사일보다 앞선 퇴직일은 받지 않는다 — 일한 기간의 스케줄까지 지우게 된다', async () => {
      const staffId = await createStaff('JOINED', day(-10));

      await expect(
        retirement.retire(adminId, staffId, day(-11)),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        retirement.retire(adminId, staffId, day(-10)),
      ).resolves.toBeUndefined();
    });

    it('가입 전 레코드는 받지 않는다', async () => {
      const staffId = await createStaff('INVITED');

      await expect(
        retirement.retire(adminId, staffId, day(10)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('이미 퇴직 예정이면 다시 처리하지 않는다 — 퇴직일 변경을 쓴다', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(10));

      await expect(
        retirement.retire(adminId, staffId, day(20)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('없는 직원이면 404', async () => {
      await expect(
        retirement.retire(adminId, 2_147_483_000, day(10)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('취소와 퇴직일 변경', () => {
    it('취소하면 퇴직일을 비우고 CANCEL 행을 남긴다', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(10));

      await retirement.cancel(adminId, staffId);

      expect((await staffOf(staffId)).retiredDate).toBeNull();
      const logs = await logsOf(staffId);
      expect(logs.at(-1)).toMatchObject({
        action: 'CANCEL',
        retiredDate: day(10),
        contractId: null,
      });
    });

    it('변경하면 날짜만 바꾸고 CANCEL · RETIRE 를 남긴다', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(10));

      await retirement.changeDate(adminId, staffId, day(20));

      expect((await staffOf(staffId)).retiredDate).toEqual(day(20));
      const logs = await logsOf(staffId);
      expect(logs.slice(-2).map((l) => [l.action, l.retiredDate])).toEqual([
        ['CANCEL', day(10)],
        ['RETIRE', day(20)],
      ]);
    });

    it('지난 날짜로 바꾸면 그 자리에서 퇴직으로 바꾼다', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(10));

      await retirement.changeDate(adminId, staffId, day(-1));

      expect((await staffOf(staffId)).employmentStatus).toBe('RETIRED');
    });

    it('퇴직일 당일과 그 뒤에는 취소도 변경도 받지 않는다', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(0));

      await expect(retirement.cancel(adminId, staffId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        retirement.changeDate(adminId, staffId, day(5)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('같은 날짜로는 바꾸지 않는다 — 바뀐 것 없이 이력만 쌓인다', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(10));

      await expect(
        retirement.changeDate(adminId, staffId, day(10)),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await logsOf(staffId)).toHaveLength(1);
    });

    it('퇴직 예정이 아니면 취소할 것이 없다', async () => {
      const staffId = await createStaff();

      await expect(retirement.cancel(adminId, staffId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('배치 retireDue', () => {
    const runBatch = () =>
      prisma.$transaction((tx) => retirement.retireDue(tx, today));

    it('퇴직일이 지난 재직 레코드를 퇴직으로 바꾸고 SYSTEM 으로 정리한다', async () => {
      const staffId = await createStaff();
      // 퇴직을 처리한 관리자가 스케줄 삭제 이력의 변경 주체가 된다.
      await retirement.retire(mappedAdminId, staffId, day(3));
      // 퇴직일이 어제가 된 상황을 만든다.
      await prisma.staffMember.update({
        where: { staffMemberId: staffId },
        data: { retiredDate: day(-1) },
      });
      const after = await scheduleOn(staffId, day(0));
      const pending = await contractOf(
        staffId,
        'PENDING_SIGNATURE',
        day(5),
        null,
      );
      const todoId = await personalTodo(staffId);
      const doneTodo = await personalTodo(staffId, true);

      expect(await runBatch()).toBeGreaterThanOrEqual(1);

      expect((await staffOf(staffId)).employmentStatus).toBe('RETIRED');
      expect(
        (
          await prisma.workSchedule.findUniqueOrThrow({
            where: { workScheduleId: after.workScheduleId },
          })
        ).isDeleted,
      ).toBe(true);
      expect(await scheduleHistoriesOf(after.workScheduleId)).toEqual([
        expect.objectContaining({
          changeType: 'DELETED',
          changedBy: mappedAdminId,
        }),
      ]);
      expect(
        await prisma.contractStatusHistory.findFirst({
          where: { contractId: pending.contractId },
        }),
      ).toMatchObject({ toStatus: 'ENDED', actor: 'SYSTEM' });
      expect(await prisma.todoAssignee.count({ where: { todoId } })).toBe(0);
      expect(
        await prisma.todoStatusHistory.findFirst({ where: { todoId } }),
      ).toMatchObject({ unassignedStaffMemberId: staffId, changedBy: null });
      // 끝난 TO-DO 의 배정은 이력이라 남긴다.
      expect(
        await prisma.todoAssignee.count({ where: { todoId: doneTodo } }),
      ).toBe(1);
    });

    it('퇴직일이 오늘인 레코드는 건드리지 않는다 — 당일까지 재직', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(0));

      await runBatch();

      expect((await staffOf(staffId)).employmentStatus).toBe('EMPLOYED');
    });

    it('두 번 돌려도 같다 — 이미 퇴직한 레코드를 다시 정리하지 않는다', async () => {
      const staffId = await createStaff();
      await retirement.retire(adminId, staffId, day(3));
      await prisma.staffMember.update({
        where: { staffMemberId: staffId },
        data: { retiredDate: day(-2) },
      });
      const schedule = await scheduleOn(staffId, day(0));
      const todoId = await personalTodo(staffId);
      const pending = await contractOf(staffId, 'PENDING_SEND', day(5), null);
      await runBatch();
      const counts = () =>
        Promise.all([
          prisma.todoStatusHistory.count({ where: { todoId } }),
          prisma.contractStatusHistory.count({
            where: { contractId: pending.contractId },
          }),
          prisma.workScheduleHistory.count({
            where: { workScheduleId: schedule.workScheduleId },
          }),
        ]);
      const first = await counts();

      await runBatch();

      expect(first).toEqual([1, 1, 1]);
      expect(await counts()).toEqual(first);
      expect((await staffOf(staffId)).employmentStatus).toBe('RETIRED');
    });
  });

  describe('미리 보기', () => {
    it('처리와 같은 검사를 한다 — 확인창은 뜨는데 처리가 거부되는 일이 없게', async () => {
      const staffId = await createStaff();
      await expect(
        retirement.preview(staffId, day(-100)),
      ).rejects.toBeInstanceOf(BadRequestException);

      const invited = await createStaff('INVITED');
      await expect(retirement.preview(invited, day(10))).rejects.toBeInstanceOf(
        ConflictException,
      );

      const retired = await createStaff();
      await retirement.retire(adminId, retired, day(-1));
      await expect(retirement.preview(retired, day(10))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('퇴직 때 정리될 스케줄 · TO-DO · 대기 계약을 센다', async () => {
      const staffId = await createStaff();
      await scheduleOn(staffId, day(10));
      await scheduleOn(staffId, day(11));
      await scheduleOn(staffId, day(12));
      await personalTodo(staffId);
      const pending = await contractOf(staffId, 'PENDING_SEND', day(1), null);

      await expect(retirement.preview(staffId, day(10))).resolves.toEqual({
        schedulesToRemove: 2,
        todosToUnassign: 1,
        contractsToEnd: [
          { contractId: pending.contractId, status: 'PENDING_SEND' },
        ],
      });
    });
  });

  describe('HTTP (관리자 웹)', () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    const tokenOf = (sub: number, type: 'admin' | 'account' = 'admin') =>
      app
        .get(JwtService)
        .signAsync({ sub, type, email: 'admin@test.invalid', typ: 'access' });
    const call = async (
      method: 'get' | 'post' | 'put' | 'delete',
      path: string,
      body?: object,
      sub = adminId,
      type: 'admin' | 'account' = 'admin',
    ) => {
      const req = request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${await tokenOf(sub, type)}`);
      return body === undefined ? req : req.send(body);
    };

    it('퇴직 처리 · 퇴직일 변경 · 취소는 204 이다', async () => {
      const staffId = await createStaff();
      const path = `/staff-members/${staffId}/retirement`;

      expect(
        (await call('post', path, { retiredDate: iso(day(10)) })).status,
      ).toBe(204);
      expect(
        (await call('put', path, { retiredDate: iso(day(20)) })).status,
      ).toBe(204);
      expect((await call('delete', path)).status).toBe(204);
      expect((await staffOf(staffId)).retiredDate).toBeNull();
    });

    it('미리 보기는 퇴직일을 받아 정리될 건수를 준다', async () => {
      const staffId = await createStaff();
      await scheduleOn(staffId, day(11));

      const res = await call(
        'get',
        `/staff-members/${staffId}/retirement-preview?retiredDate=${iso(day(10))}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        schedulesToRemove: 1,
        todosToUnassign: 0,
        contractsToEnd: [],
      });
    });

    it('이미 퇴직 예정인데 다시 처리하면 409 다', async () => {
      const staffId = await createStaff();
      const path = `/staff-members/${staffId}/retirement`;
      await call('post', path, { retiredDate: iso(day(10)) });

      const res = await call('post', path, { retiredDate: iso(day(20)) });

      expect(res.status).toBe(409);
    });

    it('400 응답은 한 모양이다 — 형식이 틀리든 없는 날짜든 같은 검증에서 나온다', async () => {
      const staffId = await createStaff();
      const path = `/staff-members/${staffId}/retirement`;

      const malformed = await call('post', path, { retiredDate: '2026/10/10' });
      const impossible = await call('post', path, {
        retiredDate: '2026-02-30',
      });

      expect(
        Array.isArray((malformed.body as { message: unknown }).message),
      ).toBe(true);
      expect(
        Array.isArray((impossible.body as { message: unknown }).message),
      ).toBe(true);
    });

    it('매핑으로 이 점포를 관리하는 관리자는 처리할 수 있다', async () => {
      const staffId = await createStaff();

      const res = await call(
        'post',
        `/staff-members/${staffId}/retirement`,
        { retiredDate: iso(day(10)) },
        mappedAdminId,
      );

      expect(res.status).toBe(204);
    });

    it('관리 범위 밖 점포의 직원은 없는 직원과 같은 404 다 — 다른 점포에 그 ID 가 있다는 것도 알리지 않는다', async () => {
      const staffId = await createStaff();

      const res = await call(
        'post',
        `/staff-members/${staffId}/retirement`,
        { retiredDate: iso(day(10)) },
        otherStoreAdminId,
      );

      expect(res.status).toBe(404);
      expect((await staffOf(staffId)).retiredDate).toBeNull();
    });

    it.each(['abc', '0', '2147483648'])(
      '직원 ID 가 범위 밖(%p)이면 DB 에 묻기 전에 404 다',
      async (id) => {
        const res = await call('post', `/staff-members/${id}/retirement`, {
          retiredDate: iso(day(10)),
        });

        expect(res.status).toBe(404);
      },
    );

    it.each(['2026-02-30', '2026/10/10', ''])(
      '퇴직일 모양이 틀리면(%p) 400 이다',
      async (retiredDate) => {
        const staffId = await createStaff();

        const res = await call('post', `/staff-members/${staffId}/retirement`, {
          retiredDate,
        });

        expect(res.status).toBe(400);
      },
    );

    it('직원 앱 토큰으로는 닿을 수 없다(403)', async () => {
      const staffId = await createStaff();

      const res = await call(
        'get',
        `/staff-members/${staffId}/retirement-preview?retiredDate=${iso(day(10))}`,
        undefined,
        1,
        'account',
      );

      expect(res.status).toBe(403);
    });
  });
});
