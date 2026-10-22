import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 직원 알림함 · 알림 수신 설정(WHALEERP-265 · 268)을 실제 DB 로 — 내 것만 · 14일 보관 · 갈 곳 · 읽음 · 수신 설정 upsert.
// 알림은 만드는 쪽(근무스케줄 저장 · TO-DO 수행 임박)을 거치지 않고 행으로 넣는다.
describe('직원 알림함 · 수신 설정 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  const storeIds: number[] = [];
  let adminId: number;
  const accountIds: number[] = [];
  const staffIds: number[] = [];
  const notificationIds: number[] = [];
  let mineAccountId: number;
  let otherAccountId: number;
  /** 내 재직 소속(점포 A) */
  let activeId: number;
  /** 내 퇴직한 소속(점포 B) */
  let retiredId: number;
  let token: string;
  let scheduleOfActive: number;
  let deletedScheduleOfActive: number;
  let scheduleOfRetired: number;
  let todoOfStoreA: number;
  let deletedTodo: number;

  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  beforeAll(async () => {
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

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '알림함 테스트 BP',
      },
    }));
    for (const offset of [0, 1]) {
      const { storeId } = await prisma.store.create({
        data: {
          storeCode: `ST${(n + offset) % 1_000_000}`,
          bpCodeId,
          storeTypeCode: 'DIRECT',
          name: `알림함 점포 ${offset}`,
          storeStatusCode: 'OPERATING',
        },
      });
      storeIds.push(storeId);
    }
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `noti${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    const account = async () => {
      const m = randomInt(10_000_000, 99_999_999);
      const { accountId } = await prisma.account.create({
        data: {
          email: `noti-${m}@test.invalid`,
          passwordHash: '!',
          realName: '알림',
          birthDate: new Date('1990-01-01'),
          phone: `010${m}`,
          status: 'JOINED',
        },
      });
      accountIds.push(accountId);
      return accountId;
    };
    mineAccountId = await account();
    otherAccountId = await account();
    const record = async (storeId: number, retired: boolean) => {
      const { staffMemberId } = await prisma.staffMember.create({
        data: {
          storeId,
          accountId: mineAccountId,
          name: '알림',
          phone: '01000000000',
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: 'JOINED',
          ...(retired
            ? {
                employmentStatus: 'RETIRED' as const,
                retiredDate: new Date(now - 10 * DAY),
              }
            : {}),
        },
      });
      staffIds.push(staffMemberId);
      await prisma.contract.create({
        data: {
          staffMemberId,
          storeId,
          employmentType: 'PART_TIME',
          contractMethod: 'ELECTRONIC',
          startDate: new Date(now - 60 * DAY),
          isHealthPensionInsured: false,
          isEmploymentInjuryInsured: false,
          status: 'SIGNED',
          createdBy: adminId,
        },
      });
      return staffMemberId;
    };
    activeId = await record(storeIds[0], false);
    retiredId = await record(storeIds[1], true);

    const schedule = async (
      staffMemberId: number,
      storeId: number,
      startAt: string,
      isDeleted = false,
    ) =>
      (
        await prisma.workSchedule.create({
          data: {
            staffMemberId,
            storeId,
            startAt: new Date(startAt),
            endAt: new Date(new Date(startAt).getTime() + 4 * 3600_000),
            createdBy: adminId,
            isDeleted,
          },
        })
      ).workScheduleId;
    // 2026-11-02 23:30 KST 시작 — 근무일은 한국 날짜
    scheduleOfActive = await schedule(
      activeId,
      storeIds[0],
      '2026-11-02T14:30:00.000Z',
    );
    deletedScheduleOfActive = await schedule(
      activeId,
      storeIds[0],
      '2026-11-05T00:00:00.000Z',
      true,
    );
    scheduleOfRetired = await schedule(
      retiredId,
      storeIds[1],
      '2026-09-01T00:00:00.000Z',
    );
    const todo = async (isDeleted: boolean) =>
      (
        await prisma.todo.create({
          data: {
            storeId: storeIds[0],
            title: '알림함 TO-DO',
            assigneeType: 'INDIVIDUAL',
            executionMode: 'EACH',
            dueDate: new Date('2026-11-03'),
            createdBy: adminId,
            isDeleted,
          },
        })
      ).todoId;
    todoOfStoreA = await todo(false);
    deletedTodo = await todo(true);

    const session = await app
      .get(AuthSessionService)
      .issue({ accountId: mineAccountId });
    token = await app.get(JwtService).signAsync({
      sub: mineAccountId,
      type: 'account',
      email: 'noti@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notificationDelivery.deleteMany({
      where: {
        notificationRecipient: { notificationId: { in: notificationIds } },
      },
    });
    await prisma.notificationRecipient.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.notification.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.notificationPreference.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.todo.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.workSchedule.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.contract.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.staffMember.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    if (adminId !== undefined) {
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: adminId },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: adminId },
      });
    }
    await prisma.store.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  /** 알림 하나와 받는 사람 하나. 받은 시각을 정할 수 있다. 받는 사람별 id 를 준다 */
  async function notify(input: {
    accountId?: number;
    templateCode?: string;
    relatedType?: string | null;
    relatedId?: number | null;
    title: string;
    ageMs?: number;
    target?: 'STAFF' | 'ADMIN';
    isUrgent?: boolean;
  }): Promise<number> {
    const createdAt = new Date(now - (input.ageMs ?? 0));
    const { notificationId } = await prisma.notification.create({
      data: {
        notificationTarget: input.target ?? 'STAFF',
        templateCode: input.templateCode ?? 'PUSH_SCHEDULE_CHANGED',
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        title: input.title,
        body: `${input.title} 내용`,
        isUrgent: input.isUrgent ?? false,
        createdAt,
      },
    });
    notificationIds.push(notificationId);
    const { notificationRecipientId } =
      await prisma.notificationRecipient.create({
        data: {
          notificationId,
          ...(input.target === 'ADMIN'
            ? { adminAccountId: adminId }
            : { accountId: input.accountId ?? mineAccountId }),
          createdAt,
        },
      });
    return notificationRecipientId;
  }

  const as = (
    method: 'get' | 'post' | 'put',
    path: string,
    body?: object,
    t = token,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${t}`);
    return body === undefined ? req : req.send(body);
  };

  type Item = {
    id: number;
    title: string;
    isRead: boolean;
    category: string | null;
    isUrgent: boolean;
    target: unknown;
  };
  const list = async (query = '') => {
    const res = await as('get', `/me/notifications${query}`);
    expect(res.status).toBe(200);
    return res.body as { items: Item[]; total: number; unreadCount: number };
  };

  describe('알림함', () => {
    let ids: Record<string, number>;

    beforeAll(async () => {
      ids = {
        old: await notify({ title: '15일 전', ageMs: 15 * DAY }),
        edge: await notify({
          title: '13일 23시간 전',
          ageMs: 14 * DAY - 3600_000,
        }),
        schedule: await notify({
          title: '근무스케줄',
          relatedType: 'WORK_SCHEDULE',
          relatedId: scheduleOfActive,
          ageMs: 3 * 3600_000,
        }),
        deletedSchedule: await notify({
          title: '지운 근무스케줄',
          relatedType: 'WORK_SCHEDULE',
          relatedId: deletedScheduleOfActive,
          ageMs: 2 * 3600_000,
        }),
        retiredSchedule: await notify({
          title: '퇴직한 소속의 근무스케줄',
          relatedType: 'WORK_SCHEDULE',
          relatedId: scheduleOfRetired,
          ageMs: 5 * DAY,
        }),
        todo: await notify({
          title: 'TO-DO',
          templateCode: 'PUSH_TODO_DUE_SOON',
          relatedType: 'TODO',
          relatedId: todoOfStoreA,
          isUrgent: true,
          ageMs: 3600_000,
        }),
        deletedTodo: await notify({
          title: '지운 TO-DO',
          templateCode: 'PUSH_TODO_DUE_SOON',
          relatedType: 'TODO',
          relatedId: deletedTodo,
          ageMs: 4 * 3600_000,
        }),
        others: await notify({
          title: '남의 것',
          accountId: otherAccountId,
        }),
        admin: await notify({ title: '운영 알림', target: 'ADMIN' }),
      };
    });

    it('내 직원 알림 중 14일 안의 것만, 새것부터, 미확인 건수와 갈 곳을 준다', async () => {
      const body = await list();
      expect(body.items.map((i) => i.title)).toEqual([
        'TO-DO',
        '지운 근무스케줄',
        '근무스케줄',
        '지운 TO-DO',
        '퇴직한 소속의 근무스케줄',
        '13일 23시간 전',
      ]);
      expect(body.total).toBe(6);
      expect(body.unreadCount).toBe(6);
      const byTitle = new Map(body.items.map((i) => [i.title, i]));
      expect(byTitle.get('근무스케줄')).toMatchObject({
        id: ids.schedule,
        category: 'SCHEDULE',
        isRead: false,
        isUrgent: false,
        target: {
          type: 'WORK_SCHEDULE',
          staffMemberId: activeId,
          workDate: '2026-11-02',
        },
      });
      // 지운 근무스케줄도 그 날짜의 달력으로 간다
      expect(byTitle.get('지운 근무스케줄')!.target).toEqual({
        type: 'WORK_SCHEDULE',
        staffMemberId: activeId,
        workDate: '2026-11-05',
      });
      expect(byTitle.get('TO-DO')).toMatchObject({
        category: 'TODO',
        isUrgent: true,
        target: { type: 'TODO', staffMemberId: activeId, todoId: todoOfStoreA },
      });
      expect(byTitle.get('지운 TO-DO')!.target).toBeNull();
      expect(byTitle.get('퇴직한 소속의 근무스케줄')!.target).toBeNull();
      expect(byTitle.get('13일 23시간 전')!.target).toBeNull();

      const page = await list('?page=2&pageSize=4');
      expect(page.items.map((i) => i.title)).toEqual([
        '퇴직한 소속의 근무스케줄',
        '13일 23시간 전',
      ]);
      expect(page.total).toBe(6);
    });

    it('한 줄 읽음 · 안 읽음, 모두 읽음 — 남의 것 · 14일 지난 것 · 운영 알림은 404', async () => {
      const read = await as('post', `/me/notifications/${ids.schedule}/read`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ id: ids.schedule, isRead: true });
      expect((await list()).unreadCount).toBe(5);

      const unread = await as(
        'post',
        `/me/notifications/${ids.schedule}/unread`,
      );
      expect(unread.status).toBe(200);
      expect(unread.body).toMatchObject({ isRead: false });
      expect((await list()).unreadCount).toBe(6);

      for (const id of [ids.others, ids.old, ids.admin])
        for (const action of ['read', 'unread'])
          expect([
            id,
            action,
            (await as('post', `/me/notifications/${id}/${action}`)).status,
          ]).toEqual([id, action, 404]);
      expect(
        (await as('post', '/me/notifications/2147483648/read')).status,
      ).toBe(404);

      const all = await as('post', '/me/notifications/read-all');
      expect(all.status).toBe(200);
      expect(all.body).toEqual({ updated: 6 });
      expect((await list()).unreadCount).toBe(0);
      // 14일 지난 것 · 남의 것은 그대로다
      const untouched = await prisma.notificationRecipient.findMany({
        where: { notificationRecipientId: { in: [ids.old, ids.others] } },
        select: { isRead: true },
      });
      expect(untouched.every((r) => !r.isRead)).toBe(true);
    });

    it('관리자 토큰은 403', async () => {
      const adminToken = (
        await app
          .get(AdminSessionService)
          .issue({ adminAccountId: adminId }, (sid) =>
            app.get(JwtService).signAsync({
              sub: adminId,
              type: 'admin',
              loginId: `admin${adminId}`,
              typ: 'access',
              sid,
            }),
          )
      ).accessToken;
      expect(
        (await as('get', '/me/notifications', undefined, adminToken)).status,
      ).toBe(403);
      expect(
        (await as('get', '/me/notification-preferences', undefined, adminToken))
          .status,
      ).toBe(403);
    });
  });

  describe('수신 설정', () => {
    const prefs = async () => {
      const res = await as('get', '/me/notification-preferences');
      expect(res.status).toBe(200);
      return (res.body as { items: { category: string; isEnabled: boolean }[] })
        .items;
    };

    it('행이 없으면 네 묶음 모두 켜짐, 끄고 다시 켜면 한 줄을 고친다 — 근로계약서 · 급여명세서도 끈다', async () => {
      expect(await prefs()).toEqual([
        { category: 'CONTRACT', isEnabled: true },
        { category: 'SCHEDULE', isEnabled: true },
        { category: 'TODO', isEnabled: true },
        { category: 'PAYSLIP', isEnabled: true },
      ]);
      for (const category of ['CONTRACT', 'PAYSLIP', 'TODO']) {
        const res = await as(
          'put',
          `/me/notification-preferences/${category}`,
          { isEnabled: false },
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ category, isEnabled: false });
      }
      expect(
        (
          await as('put', '/me/notification-preferences/TODO', {
            isEnabled: true,
          })
        ).body,
      ).toEqual({ category: 'TODO', isEnabled: true });
      expect(await prefs()).toEqual([
        { category: 'CONTRACT', isEnabled: false },
        { category: 'SCHEDULE', isEnabled: true },
        { category: 'TODO', isEnabled: true },
        { category: 'PAYSLIP', isEnabled: false },
      ]);
      expect(
        await prisma.notificationPreference.count({
          where: { accountId: mineAccountId },
        }),
      ).toBe(3);
      // 남의 설정은 그대로다
      expect(
        await prisma.notificationPreference.count({
          where: { accountId: otherAccountId },
        }),
      ).toBe(0);
    });

    it('모르는 묶음 · 값 형식이 틀리면 400', async () => {
      expect(
        (
          await as('put', '/me/notification-preferences/ETC', {
            isEnabled: false,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await as('put', '/me/notification-preferences/TODO', {
            isEnabled: 'no',
          })
        ).status,
      ).toBe(400);
      expect(
        (await as('put', '/me/notification-preferences/TODO', {})).status,
      ).toBe(400);
    });
  });
});
