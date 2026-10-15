import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  INestApplication,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
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
  let franchiseStoreId: number;
  /** 이 점포를 매핑으로 관리하는 관리자 */
  let mappedAdminId: number;
  let otherStoreId: number;
  /**
   * 직원 정보 관리(MN000005) 조회만 켠 권한 그룹의 관리자. 범위는 mappedAdminId 와 같다(이 점포 매핑) —
   * 둘은 권한만 다르다.
   */
  let readOnlyAdminId: number;
  /** 수정 권한을 켰다가 끄는 권한 그룹의, 전체 점포 관리자 */
  let revokedAdminId: number;
  /** revokedAdminId 의 권한 그룹 — 테스트가 이 그룹의 수정 권한을 끈다 */
  let revokedRoleGroupId: number;
  const testRoleGroupIds: number[] = [];
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
    ({ storeId: franchiseStoreId } = await prisma.store.create({
      data: {
        storeCode: `ST${(n + 2) % 1_000_000}`,
        bpCodeId,
        storeTypeCode: 'FRANCHISE',
        name: '가맹 점포',
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
    // 직원 정보 관리 권한만 다른 관리자 — 메뉴 권한만으로 막히는지 본다(WHALEERP-586).
    // mappedStoreId 가 없으면 전체 점포, 있으면 그 점포만 관리한다.
    const staffMenu = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000005' },
    });
    const adminWithStaffMenu = async (
      prefix: string,
      grant: { isReadable: boolean; isUpdatable: boolean },
      mappedStoreId?: number,
    ) => {
      const { roleGroupId } = await prisma.roleGroup.create({
        data: {
          // role_code CHECK 는 `^[A-Z]{2}[0-9]{6}$` — 999999 + 1 이 0 으로 돌아도 6자리를 맞춘다.
          roleCode: `BA${String((n + testRoleGroupIds.length) % 1_000_000).padStart(6, '0')}`,
          bpCodeId,
          roleTypeCode: 'BA',
          name: `퇴직 권한 ${prefix} ${n}`,
          menus: { create: { menuId: staffMenu.menuId, ...grant } },
        },
      });
      testRoleGroupIds.push(roleGroupId);
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${prefix}${n}`,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode: 'BA',
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: mappedStoreId === undefined,
          accountStatusCode: 'ACTIVE',
          ...(mappedStoreId === undefined
            ? {}
            : { storeMappings: { create: { storeId: mappedStoreId } } }),
        },
      });
      return { adminAccountId, roleGroupId };
    };
    ({ adminAccountId: readOnlyAdminId } = await adminWithStaffMenu(
      'readonly',
      { isReadable: true, isUpdatable: false },
      storeId,
    ));
    ({ adminAccountId: revokedAdminId, roleGroupId: revokedRoleGroupId } =
      await adminWithStaffMenu('revoked', {
        isReadable: true,
        isUpdatable: true,
      }));
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
      where: { storeId: { in: [storeId, otherStoreId] } },
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
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    // beforeAll 이 중간에 실패하면 만들지 못한 관리자의 id 가 undefined 다 — 그대로 넣으면 정리가 멈춘다.
    const adminIds = [
      adminId,
      otherStoreAdminId,
      mappedAdminId,
      readOnlyAdminId,
      revokedAdminId,
    ].filter((id): id is number => id !== undefined);
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminStoreMapping.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.roleGroupMenu.deleteMany({
      where: { roleGroupId: { in: testRoleGroupIds } },
    });
    await prisma.roleGroup.deleteMany({
      where: { roleGroupId: { in: testRoleGroupIds } },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [storeId, otherStoreId, franchiseStoreId] } },
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
    status: 'SIGNED' | 'DRAFT' | 'PENDING_SEND' | 'PENDING_SIGNATURE',
    startDate: Date,
    endDate: Date | null,
    store = storeId,
  ) =>
    prisma.contract.create({
      data: {
        staffMemberId,
        storeId: store,
        employmentType: 'PART_TIME',
        contractMethod: 'ELECTRONIC',
        startDate,
        endDate,
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status,
        createdBy: adminId,
      },
    });

  const scheduleOn = (staffMemberId: number, date: Date, store = storeId) =>
    prisma.workSchedule.create({
      data: {
        staffMemberId,
        storeId: store,
        ...shiftOn(date),
        breakMinutes: 0,
        createdBy: adminId,
      },
    });

  async function personalTodo(
    staffMemberId: number,
    isCompleted = false,
    store = storeId,
  ) {
    const todo = await prisma.todo.create({
      data: {
        storeId: store,
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
      const draft = await contractOf(staffId, 'DRAFT', day(1), null);
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
      // 임시저장도 닫는다 — 나중에 이어 써서 퇴직자에게 보내지 않게 (2026-10-12 재영)
      expect(
        (
          await prisma.contract.findUniqueOrThrow({
            where: { contractId: draft.contractId },
          })
        ).status,
      ).toBe('ENDED');
      expect(
        await prisma.contractStatusHistory.findFirst({
          where: { contractId: draft.contractId },
        }),
      ).toMatchObject({
        fromStatus: 'DRAFT',
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

    it('한 명이 실패해도 다른 직원은 확정된다 — 실패한 직원만 남기고 직원 ID 로 남긴다', async () => {
      // API 밖에서 퇴직일만 넣은 레코드(RETIRE 로그 없음)에 지울 스케줄이 있으면 삭제 이력의 변경 주체를
      // 정할 수 없어 확정이 실패한다. 그 직원 하나 때문에 그날 밤 전체가 롤백되면 안 된다.
      const broken = await createStaff();
      await prisma.staffMember.update({
        where: { staffMemberId: broken },
        data: { retiredDate: day(-1) },
      });
      const brokenSchedule = await scheduleOn(broken, day(1));
      const healthy = await createStaff();
      await retirement.retire(adminId, healthy, day(3));
      await prisma.staffMember.update({
        where: { staffMemberId: healthy },
        data: { retiredDate: day(-1) },
      });
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(runBatch()).resolves.toBeGreaterThanOrEqual(1);

      expect((await staffOf(healthy)).employmentStatus).toBe('RETIRED');
      // 실패한 직원은 확정 전 그대로다 — 퇴직인데 스케줄이 남는 반쪽 상태를 만들지 않는다.
      expect((await staffOf(broken)).employmentStatus).toBe('EMPLOYED');
      expect(
        (
          await prisma.workSchedule.findUniqueOrThrow({
            where: { workScheduleId: brokenSchedule.workScheduleId },
          })
        ).isDeleted,
      ).toBe(false);
      expect(JSON.stringify(logged.mock.calls)).toContain(
        `staffMemberId=${broken}`,
      );
      logged.mockRestore();
      // 다음 테스트의 배치가 같은 레코드에서 또 실패하지 않게 치운다.
      await prisma.workSchedule.update({
        where: { workScheduleId: brokenSchedule.workScheduleId },
        data: { isDeleted: true },
      });
      await prisma.staffMember.update({
        where: { staffMemberId: broken },
        data: { retiredDate: null },
      });
    });

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
      const draft = await contractOf(staffId, 'DRAFT', day(1), null);

      await expect(retirement.preview(staffId, day(10))).resolves.toEqual({
        schedulesToRemove: 2,
        todosToUnassign: 1,
        contractsToEnd: [
          { contractId: pending.contractId, status: 'PENDING_SEND' },
          { contractId: draft.contractId, status: 'DRAFT' },
        ],
      });
    });
  });

  describe('HTTP (관리자 웹)', () => {
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    // 관리자 토큰은 살아 있는 관리자 세션(admin_sessions)이 있어야 가드를 통과한다.
    const tokenOf = async (sub: number) =>
      (
        await app
          .get(AdminSessionService)
          .issue({ adminAccountId: sub }, (sid) =>
            app.get(JwtService).signAsync({
              sub,
              type: 'admin',
              loginId: `admin${sub}`,
              typ: 'access',
              sid,
            }),
          )
      ).accessToken;
    /** `as` 가 관리자 ID 면 부를 때마다 새로 로그인한 토큰을, `{ token }` 이면 그 토큰을 그대로 쓴다. */
    const call = async (
      method: 'get' | 'post' | 'put' | 'delete',
      path: string,
      body?: object,
      as: number | { token: string } = adminId,
    ) => {
      const token = typeof as === 'number' ? await tokenOf(as) : as.token;
      const req = request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${token}`);
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

    it('직원 정보 관리 수정 권한이 없으면 범위 안 직원이어도 미리 보기 · 처리 · 변경 · 취소 모두 403 이다', async () => {
      const staffId = await createStaff();
      const path = `/staff-members/${staffId}/retirement`;
      const preview = `/staff-members/${staffId}/retirement-preview?retiredDate=${iso(day(10))}`;

      const statuses = [
        (await call('get', preview, undefined, readOnlyAdminId)).status,
        (
          await call(
            'post',
            path,
            { retiredDate: iso(day(10)) },
            readOnlyAdminId,
          )
        ).status,
      ];
      // 변경 · 취소는 퇴직 예정이어야 닿으므로, 권한 있는 관리자가 먼저 처리해 둔다.
      await call('post', path, { retiredDate: iso(day(10)) });
      statuses.push(
        (
          await call(
            'put',
            path,
            { retiredDate: iso(day(20)) },
            readOnlyAdminId,
          )
        ).status,
        (await call('delete', path, undefined, readOnlyAdminId)).status,
      );

      expect(statuses).toEqual([403, 403, 403, 403]);
      expect((await staffOf(staffId)).retiredDate).toEqual(day(10));
      expect(await logsOf(staffId)).toHaveLength(1);
    });

    // 권한 판정이 범위 판정보다 먼저여야 한다. 범위를 먼저 보면(가드 대신 핸들러 안에서 범위 → 권한 순으로
    // 판정하는 회귀) 권한 없는 관리자가 없는 id · 범위 밖 직원에는 404, 범위 안 직원에는 403 을 받아 응답만으로
    // 그 id 가 자기 범위의 직원인지 알게 된다. 그 회귀에서 이 테스트는 403 대신 404 를 받아 실패한다.
    it('수정 권한이 없으면 어떤 id 든 같은 403 이다 — 없는 직원 · 범위 밖 직원도 404 로 갈리지 않는다', async () => {
      const outOfScope = await prisma.staffMember.create({
        data: {
          storeId: otherStoreId,
          name: '다른점포직원',
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
        },
      });
      staffIds.push(outOfScope.staffMemberId);
      const date = { retiredDate: iso(day(10)) };
      // 미리 보기 · 처리 · 변경 · 취소를 그 id 로 한 번씩, 차례로 부른다. supertest 가 요청마다 임시 서버를 열어
      // 한꺼번에 보내면 연결이 끊긴다(ECONNRESET).
      const allRoutes = async (id: number, as: number) => [
        await call(
          'get',
          `/staff-members/${id}/retirement-preview?retiredDate=${date.retiredDate}`,
          undefined,
          as,
        ),
        await call('post', `/staff-members/${id}/retirement`, date, as),
        await call('put', `/staff-members/${id}/retirement`, date, as),
        await call('delete', `/staff-members/${id}/retirement`, undefined, as),
      ];
      const ids = [2_147_483_647, outOfScope.staffMemberId];

      // 같은 범위(이 점포 매핑)에 수정 권한이 있는 관리자에게는 모두 404 다 — 범위 판정이 걸리는 id 다.
      for (const id of ids)
        expect(
          (await allRoutes(id, mappedAdminId)).map((res) => res.status),
        ).toEqual([404, 404, 404, 404]);

      const denied: Awaited<ReturnType<typeof allRoutes>> = [];
      for (const id of ids)
        denied.push(...(await allRoutes(id, readOnlyAdminId)));
      expect(denied.map((res) => res.status)).toEqual(Array(8).fill(403));
      for (const res of denied) expect(res.body).toEqual(denied[0].body);
      expect((await staffOf(outOfScope.staffMemberId)).retiredDate).toBeNull();
    });

    it('수정 권한을 끄면 다시 로그인하지 않아도 다음 요청부터 403 이다', async () => {
      const staffId = await createStaff();
      const preview = `/staff-members/${staffId}/retirement-preview?retiredDate=${iso(day(10))}`;
      // 한 번 로그인한 토큰 · 세션을 끝까지 쓴다 — 요청마다 새로 받으면 로그인 때 권한을 읽어 두는 회귀를 놓친다.
      const session = { token: await tokenOf(revokedAdminId) };
      expect((await call('get', preview, undefined, session)).status).toBe(200);

      await prisma.roleGroupMenu.updateMany({
        where: { roleGroupId: revokedRoleGroupId },
        data: { isUpdatable: false },
      });

      expect((await call('get', preview, undefined, session)).status).toBe(403);
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

    it('BP 마스터는 가맹 점포 직원을 미리보기도 처리도 못 한다 — 목록에서 가린 직원이다(ATT-30)', async () => {
      // adminId 는 소속 BP 전체 점포를 관리하는 BM 이라 점포 범위로는 걸리지 않는다. 역할 · 점포 유형으로 막는다.
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId: franchiseStoreId,
          name: '가맹직원',
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'DRAFT',
        },
      });
      staffIds.push(staffMemberId);

      const preview = await call(
        'get',
        `/staff-members/${staffMemberId}/retirement-preview?retiredDate=${iso(day(10))}`,
      );
      const retire = await call(
        'post',
        `/staff-members/${staffMemberId}/retirement`,
        { retiredDate: iso(day(10)) },
      );

      expect(preview.status).toBe(404);
      expect(retire.status).toBe(404);
      expect((await staffOf(staffMemberId)).retiredDate).toBeNull();
    });

    it('본사 제공 동의한 가맹 점포 직원은 BP 마스터가 미리볼 수 있다', async () => {
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId: franchiseStoreId,
          name: '동의직원',
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
          isHqSharingConsented: true,
          hqSharingConsentVersion: 'v1',
          hqSharingAgreedAt: new Date(),
        },
      });
      staffIds.push(staffMemberId);

      const preview = await call(
        'get',
        `/staff-members/${staffMemberId}/retirement-preview?retiredDate=${iso(day(10))}`,
      );

      expect(preview.status).toBe(200);
    });

    it('본사 제공 동의를 철회한 가맹 점포 직원은 BP 마스터에게 다시 404 다', async () => {
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId: franchiseStoreId,
          name: '철회직원',
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
          isHqSharingConsented: false,
          hqSharingConsentVersion: 'v1',
          hqSharingAgreedAt: new Date('2026-10-01T00:00:00Z'),
          hqSharingWithdrawnAt: new Date('2026-10-05T00:00:00Z'),
        },
      });
      staffIds.push(staffMemberId);

      const preview = await call(
        'get',
        `/staff-members/${staffMemberId}/retirement-preview?retiredDate=${iso(day(10))}`,
      );

      expect(preview.status).toBe(404);
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

    /** createStaff 의 계정으로 다른 점포(otherStoreId)에 둔 재직 직원 레코드 — 같은 사람의 다른 근무지. */
    async function sameAccountAtOtherStore(staffId: number) {
      const { accountId } = await staffOf(staffId);
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId: otherStoreId,
          accountId,
          name: '홍길동',
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'PART_TIME',
          jobTitle: '주방',
          joinStatus: 'JOINED',
        },
      });
      staffIds.push(staffMemberId);
      return { accountId: accountId as number, otherId: staffMemberId };
    }

    it('지난 날짜로 퇴직이 확정돼도 같은 계정의 다른 근무지 레코드는 그대로다', async () => {
      const staffId = await createStaff();
      const { accountId, otherId } = await sameAccountAtOtherStore(staffId);
      // 확정 때 정리되는 것들을 양쪽에 똑같이 둔다 — 정리가 직원 레코드가 아니라 사람 단위로 번지면 드러난다.
      await scheduleOn(staffId, day(5));
      await personalTodo(staffId);
      await contractOf(staffId, 'PENDING_SEND', day(30), null);
      const otherSchedule = await scheduleOn(otherId, day(5), otherStoreId);
      const otherTodoId = await personalTodo(otherId, false, otherStoreId);
      const otherContract = await contractOf(
        otherId,
        'PENDING_SEND',
        day(30),
        null,
        otherStoreId,
      );
      const accountBefore = await prisma.account.findUniqueOrThrow({
        where: { accountId },
      });

      const res = await call('post', `/staff-members/${staffId}/retirement`, {
        retiredDate: iso(day(-1)),
      });

      expect(res.status).toBe(204);
      expect((await staffOf(staffId)).employmentStatus).toBe('RETIRED');
      expect(await staffOf(otherId)).toMatchObject({
        employmentStatus: 'EMPLOYED',
        retiredDate: null,
        accountId,
      });
      expect(
        await prisma.workSchedule.findUniqueOrThrow({
          where: { workScheduleId: otherSchedule.workScheduleId },
        }),
      ).toMatchObject({ isDeleted: false });
      expect(
        await prisma.todoAssignee.count({
          where: { todoId: otherTodoId, staffMemberId: otherId },
        }),
      ).toBe(1);
      expect(
        await prisma.contract.findUniqueOrThrow({
          where: { contractId: otherContract.contractId },
        }),
      ).toMatchObject({ status: 'PENDING_SEND' });
      expect(await logsOf(otherId)).toEqual([]);
      expect(
        await prisma.account.findUniqueOrThrow({ where: { accountId } }),
      ).toMatchObject({ status: accountBefore.status });
    });

    it('퇴직 예정 처리와 취소도 같은 계정의 다른 근무지 레코드에 닿지 않는다', async () => {
      const staffId = await createStaff();
      const { otherId } = await sameAccountAtOtherStore(staffId);
      const path = `/staff-members/${staffId}/retirement`;

      expect(
        (await call('post', path, { retiredDate: iso(day(10)) })).status,
      ).toBe(204);
      expect((await staffOf(otherId)).retiredDate).toBeNull();
      expect((await call('delete', path)).status).toBe(204);

      expect(await staffOf(otherId)).toMatchObject({
        employmentStatus: 'EMPLOYED',
        retiredDate: null,
      });
      expect(await logsOf(otherId)).toEqual([]);
    });

    it('직원 앱 토큰으로는 닿을 수 없다(403)', async () => {
      const staffId = await createStaff();
      // 살아 있는 직원 앱 접속의 토큰이어야 한다. 가드는 account 토큰의 접속 상태(sid)를 먼저 확인하므로,
      // 접속 상태가 없는 토큰은 종류를 따지기 전에 401 로 끝나 이 경로의 종류 제한을 증명하지 못한다.
      const accountId = accountIds[accountIds.length - 1];
      const session = await app
        .get(AuthSessionService)
        .issue({ accountId, deviceIdentifier: 'retirement-e2e' });
      const token = await app.get(JwtService).signAsync({
        sub: accountId,
        type: 'account',
        email: 'staff@test.invalid',
        typ: 'access',
        sid: session.authSessionId,
      });

      const res = await request(app.getHttpServer())
        .get(
          `/staff-members/${staffId}/retirement-preview?retiredDate=${iso(day(10))}`,
        )
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });
});
