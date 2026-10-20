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
import { addDays, kstToday } from '../src/staff-members/kst-date';
import { TodoDueSoonService } from '../src/todos/todo-due-soon.service';

// TO-DO 를 실제 DB 로 확인한다 — 본사 제공 동의 가림(운영 정책 ATT-30), 「재직 직원」 기준(체결 완료 계약 · 가입 완료 ·
// 퇴직 전), 한 명 수행 완료 선점(조건부 UPDATE), 수행 임박 알림의 부분 고유 인덱스 dedupe. 목으로는 쿼리 모양만 보인다.
describe('TO-DO (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  /** BP 마스터 — 전체 점포 */
  let bmId: number;
  /** 가맹 점포: 동의함 · 동의 안 함 · 종이 계약 체결 완료지만 가입 전 */
  let consentedId: number;
  let unconsentedId: number;
  let paperUnjoinedId: number;
  let joinedNoAccountId: number; // 가입 완료인데 계정이 없는 레코드 — ACTIVE_STAFF 를 지나 동의 조건만이 거른다
  /** 직영 점포 재직 직원 둘(계정 있음) */
  let direct1: { staffMemberId: number; accountId: number };
  let direct2: { staffMemberId: number; accountId: number };
  const staffIds: number[] = [];
  const accountIds: number[] = [];
  const today = kstToday();
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  beforeAll(async () => {
    // 수행 임박 알림은 DB 전체의 TO-DO 를 본다. 공용 개발 DB 에서 돌면 남의 직원에게 알림이 간다 — 일회용 DB 를 명시해야만 돈다.
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
        tradeName: 'TO-DO 테스트 BP',
      },
    }));
    const store = (offset: number, storeTypeCode: string) =>
      prisma.store.create({
        data: {
          storeCode: `ST${(n + offset) % 1_000_000}`,
          bpCodeId,
          storeTypeCode,
          name: `TO-DO ${storeTypeCode}`,
          storeStatusCode: 'OPERATING',
        },
      });
    ({ storeId: directStoreId } = await store(0, 'DIRECT'));
    ({ storeId: franchiseStoreId } = await store(1, 'FRANCHISE'));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `todo${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));

    consentedId = (await staff(franchiseStoreId, '동의함', { consented: true }))
      .staffMemberId;
    unconsentedId = (await staff(franchiseStoreId, '동의안함')).staffMemberId;
    paperUnjoinedId = (
      await staff(franchiseStoreId, '가입전', { joined: false })
    ).staffMemberId;
    joinedNoAccountId = (
      await staff(franchiseStoreId, '계정없음', { withAccount: false })
    ).staffMemberId;
    direct1 = (await staff(directStoreId, '직영하나')) as typeof direct1;
    direct2 = (await staff(directStoreId, '직영둘')) as typeof direct2;
  });

  /** 체결 완료 계약이 있는 직원 레코드. joined 면 계정까지 만든다(withAccount: false 면 가입 완료여도 계정 없이) */
  async function staff(
    storeId: number,
    name: string,
    {
      joined = true,
      consented = false,
      withAccount = joined,
    }: { joined?: boolean; consented?: boolean; withAccount?: boolean } = {},
  ) {
    const n = randomInt(10_000_000, 99_999_999);
    let accountId: number | null = null;
    if (withAccount) {
      ({ accountId } = await prisma.account.create({
        data: {
          email: `todo-${n}@test.invalid`,
          passwordHash: '!',
          realName: name,
          birthDate: new Date('1990-01-01'),
          phone: `010${n}`,
          status: 'JOINED',
          // 본사 제공 동의는 계정에 있다(2026-10-20)
          isHqSharingConsented: consented,
          ...(consented
            ? { hqSharingConsentVersion: 'v1', hqSharingAgreedAt: new Date() }
            : {}),
        },
      }));
      accountIds.push(accountId);
    }
    const { staffMemberId } = await prisma.staffMember.create({
      data: {
        storeId,
        accountId,
        name,
        phone: `010${n}`,
        employmentType: 'PART_TIME',
        jobTitle: '홀',
        joinStatus: joined ? 'JOINED' : 'DRAFT',
      },
    });
    staffIds.push(staffMemberId);
    // 종이 계약은 가입 전에도 체결 완료다
    await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: joined ? 'ELECTRONIC' : 'PAPER',
        startDate: addDays(today, -30),
        endDate: null,
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'SIGNED',
        createdBy: bmId,
      },
    });
    return { staffMemberId, accountId };
  }

  afterAll(async () => {
    if (!prisma) return;
    const todos = await prisma.todo.findMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId] } },
      select: { todoId: true },
    });
    const todoIds = todos.map((t) => t.todoId);
    const notifications = await prisma.notification.findMany({
      where: { relatedType: 'TODO', relatedId: { in: todoIds } },
      select: { notificationId: true },
    });
    const notificationIds = notifications.map((x) => x.notificationId);
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
    await prisma.todoStatusHistory.deleteMany({
      where: { todoId: { in: todoIds } },
    });
    await prisma.todoAssignee.deleteMany({
      where: { todoId: { in: todoIds } },
    });
    await prisma.todo.deleteMany({ where: { todoId: { in: todoIds } } });
    await prisma.contract.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.staffMember.deleteMany({
      where: { staffMemberId: { in: staffIds } },
    });
    await prisma.authSession.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    if (bmId !== undefined) {
      await prisma.adminSession.deleteMany({ where: { adminAccountId: bmId } });
      await prisma.adminAccount.deleteMany({ where: { adminAccountId: bmId } });
    }
    await prisma.store.deleteMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  // 관리자 토큰은 살아 있는 관리자 세션(admin_sessions)이 있어야 가드를 통과한다.
  const adminToken = async () =>
    (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: bmId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: bmId,
            type: 'admin',
            loginId: `admin${bmId}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
  const accountToken = async (accountId: number) => {
    const session = await app
      .get(AuthSessionService)
      .issue({ accountId, deviceIdentifier: `todo-e2e-${accountId}` });
    return app.get(JwtService).signAsync({
      sub: accountId,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: session.authSessionId,
    });
  };
  const asAdmin = async (
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await adminToken()}`);
    return body === undefined ? req : req.send(body);
  };
  const todoBody = (patch: object) => ({
    title: 'e2e 할 일',
    dueDate: iso(addDays(today, 1)),
    ...patch,
  });

  describe('본사 제공 동의(운영 정책 ATT-30) — BP 마스터가 가맹 점포를 볼 때', () => {
    it('직원 고르기에는 동의한 가입 완료 직원만 나온다(동의 안 함 · 종이 계약 가입 전 · 계정 없음은 빠진다)', async () => {
      const res = await asAdmin(
        'get',
        `/todos/assignable-staff?storeId=${franchiseStoreId}`,
      );
      expect(res.status).toBe(200);
      expect(
        (res.body as { items: { staffMemberId: number }[] }).items.map(
          (i) => i.staffMemberId,
        ),
      ).toEqual([consentedId]);
    });

    it('개인 배정에 동의하지 않은 직원 · 가입 전 직원 · 계정 없는 직원이 있으면 400, 동의한 직원은 201', async () => {
      for (const id of [unconsentedId, paperUnjoinedId, joinedNoAccountId]) {
        const res = await asAdmin(
          'post',
          '/todos',
          todoBody({
            storeId: franchiseStoreId,
            assigneeType: 'INDIVIDUAL',
            staffMemberIds: [id],
          }),
        );
        expect([id, res.status]).toEqual([id, 400]);
      }
      const ok = await asAdmin(
        'post',
        '/todos',
        todoBody({
          storeId: franchiseStoreId,
          assigneeType: 'INDIVIDUAL',
          staffMemberIds: [consentedId],
        }),
      );
      expect(ok.status).toBe(201);
    });

    it('근무지 전체는 동의와 상관없이 가입 완료 재직자 모두에게 펼치고, 목록은 동의하지 않은 직원을 가린다', async () => {
      const created = await asAdmin(
        'post',
        '/todos',
        todoBody({
          storeId: franchiseStoreId,
          assigneeType: 'ALL',
          executionMode: 'EACH',
          title: '전체 배정',
        }),
      );
      expect(created.status).toBe(201);
      const { todoIds } = created.body as { todoIds: number[] };
      const assigned = await prisma.todoAssignee.findMany({
        where: { todoId: { in: todoIds } },
        select: { staffMemberId: true },
      });
      expect(assigned.map((a) => a.staffMemberId).sort()).toEqual(
        [consentedId, unconsentedId, joinedNoAccountId].sort(),
      );

      const list = await asAdmin(
        'get',
        `/todos?storeId=${franchiseStoreId}&assigneeType=ALL`,
      );
      expect(list.status).toBe(200);
      const line = (
        list.body as {
          items: { title: string; assignees: Record<string, unknown>[] }[];
        }
      ).items.find((i) => i.title === '전체 배정')!;
      expect(line.assignees).toEqual(
        expect.arrayContaining([
          {
            staffMemberId: consentedId,
            staffMemberName: '동의함',
            isMasked: false,
          },
          { staffMemberId: null, staffMemberName: null, isMasked: true },
        ]),
      );
      expect(JSON.stringify(list.body)).not.toContain('동의안함');
      expect(JSON.stringify(list.body)).not.toContain('계정없음');
    });

    it('동의하지 않은 직원 · 계정 없는 직원으로 거르면 404, 그 직원의 직원 상세 TO-DO 도 404', async () => {
      expect(
        (await asAdmin('get', `/todos?staffMemberId=${unconsentedId}`)).status,
      ).toBe(404);
      expect(
        (await asAdmin('get', `/todos?staffMemberId=${joinedNoAccountId}`))
          .status,
      ).toBe(404);
      expect(
        (await asAdmin('get', `/staff-members/${unconsentedId}/todos`)).status,
      ).toBe(404);
      expect(
        (await asAdmin('get', `/todos?staffMemberId=${consentedId}`)).status,
      ).toBe(200);
    });
  });

  it('한 명 수행 — 두 직원이 함께 완료하면 하나만 200, 늦은 쪽은 409 TODO_ALREADY_DONE', async () => {
    const created = await asAdmin(
      'post',
      '/todos',
      todoBody({
        storeId: directStoreId,
        assigneeType: 'ALL',
        executionMode: 'ANY_ONE',
        title: '공유',
      }),
    );
    expect(created.status).toBe(201);
    const [todoId] = (created.body as { todoIds: number[] }).todoIds;
    const tokens = await Promise.all(
      [direct1, direct2].map((s) => accountToken(s.accountId)),
    );

    const results = await Promise.all(
      tokens.map((token) =>
        request(app.getHttpServer())
          .patch(`/me/todos/${todoId}/status`)
          .set('Authorization', `Bearer ${token}`)
          .send({ status: 'DONE' }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body).toMatchObject({
      code: 'TODO_ALREADY_DONE',
    });
    const histories = await prisma.todoStatusHistory.count({
      where: { todoId, toStatus: 'DONE' },
    });
    expect(histories).toBe(1);
  });

  it('수행 임박 알림 — 두 번 돌아도 계정마다 하나(dedupe_key 부분 고유 인덱스)', async () => {
    const now = new Date();
    // 30분 뒤가 수행 예정 일시인 TO-DO — 한국 날짜 · 시각으로 넣는다
    const due = new Date(now.getTime() + 30 * 60_000 + 9 * 3_600_000);
    const todo = await prisma.todo.create({
      data: {
        storeId: directStoreId,
        title: '임박',
        assigneeType: 'INDIVIDUAL',
        executionMode: 'EACH',
        dueDate: new Date(`${due.toISOString().slice(0, 10)}T00:00:00.000Z`),
        dueTime: new Date(
          `1970-01-01T${due.toISOString().slice(11, 16)}:00.000Z`,
        ),
        createdBy: bmId,
        todoAssignees: { create: { staffMemberId: direct1.staffMemberId } },
      },
    });
    const dueSoon = app.get(TodoDueSoonService);

    await prisma.$transaction((tx) => dueSoon.notifyDueSoon(tx, now));
    await prisma.$transaction((tx) => dueSoon.notifyDueSoon(tx, now));

    const rows = await prisma.notification.findMany({
      where: { relatedType: 'TODO', relatedId: todo.todoId },
      include: {
        notificationRecipients: { include: { notificationDeliveries: true } },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notificationTarget: 'STAFF',
      templateCode: 'PUSH_TODO_DUE_SOON',
      title: '곧 수행할 TO-DO가 있습니다',
    });
    expect(rows[0].notificationRecipients).toHaveLength(1);
    expect(rows[0].notificationRecipients[0].accountId).toBe(direct1.accountId);
    // 앱 푸시는 발송 대기 행만 — 보낸 시각 · 결과가 비어 있다
    expect(rows[0].notificationRecipients[0].notificationDeliveries).toEqual([
      expect.objectContaining({ channel: 'PUSH', sentAt: null, result: null }),
    ]);
  });
});
