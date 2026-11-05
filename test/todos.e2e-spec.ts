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
import { HQ_SHARING_CONSENT_VERSION } from '../src/admin-scope/hq-sharing';

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
  /** 플랫폼 마스터 — 탭 BP(X-Bp-Code-Id)로 고객 BP 를 고른다 */
  let pmId: number;
  /** 플랫폼 마스터가 고를 다른 고객 BP — 이 BP 를 고르면 테스트 BP 의 TO-DO 는 범위 밖이다 */
  let otherBpCodeId: number;
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

    ({ adminAccountId: pmId } = await prisma.adminAccount.create({
      data: {
        loginId: `todopm${n}`,
        bpCodeId: (
          await prisma.bpCode.findFirstOrThrow({ where: { isPlatform: true } })
        ).bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'PM',
        roleGroupId: (
          await prisma.roleGroup.findFirstOrThrow({
            where: { roleCode: 'PM000001' },
          })
        ).roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ bpCodeId: otherBpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${(n + 1) % 1_000_000}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: 'TO-DO 테스트 다른 BP',
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
            ? {
                hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
                hqSharingAgreedAt: new Date(),
              }
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
    const adminIds = [bmId, pmId].filter((id) => id !== undefined);
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds } },
    });
    await prisma.store.deleteMany({
      where: { storeId: { in: [directStoreId, franchiseStoreId] } },
    });
    await prisma.bpCode.deleteMany({
      where: {
        bpCodeId: { in: [bpCodeId, otherBpCodeId].filter((id) => id) },
      },
    });
    await app.close();
  });

  // 관리자 토큰은 살아 있는 관리자 세션(admin_sessions)이 있어야 가드를 통과한다.
  const adminToken = async (sub = bmId) =>
    (
      await app.get(AdminSessionService).issue({ adminAccountId: sub }, (sid) =>
        app.get(JwtService).signAsync({
          sub,
          type: 'admin',
          loginId: `admin${sub}`,
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

    it('점포 범위 — storeIds(쉼표 · 반복) · storeTypes 로 거르고, 형식이 틀리면 400', async () => {
      const titlesOf = async (query: string) => {
        const res = await asAdmin('get', `/todos?pageSize=200&${query}`);
        expect([query, res.status]).toEqual([query, 200]);
        return (res.body as { items: { title: string; storeId: number }[] })
          .items;
      };
      // 앞 시험이 가맹 점포에 「전체 배정」을 만들었다
      for (const query of [
        `storeIds=${franchiseStoreId}`,
        `storeIds=${directStoreId},${franchiseStoreId}`,
        `storeIds=${directStoreId}&storeIds=${franchiseStoreId}`,
        'storeTypes=FRANCHISE',
        'storeTypes=DIRECT,FRANCHISE',
      ])
        expect((await titlesOf(query)).map((i) => i.title)).toContain(
          '전체 배정',
        );
      for (const query of [
        `storeIds=${directStoreId}`,
        'storeTypes=DIRECT',
        `storeIds=${franchiseStoreId}&storeTypes=DIRECT`,
        // 업무 범위 밖 점포는 빠진다
        'storeIds=2147483647',
      ])
        expect(
          (await titlesOf(query)).every((i) => i.storeId !== franchiseStoreId),
        ).toBe(true);
      for (const query of [
        'storeIds=abc',
        'storeIds=0',
        'storeIds=2147483648',
        'storeTypes=ETC',
      ])
        expect([
          query,
          (await asAdmin('get', `/todos?${query}`)).status,
        ]).toEqual([query, 400]);

      // 점포 유형(상단 범위 직영 · 가맹)은 폐점 점포를 뺀다 — 고른 점포 · 전체로는 보인다(2026-10-22 재영)
      await prisma.store.update({
        where: { storeId: franchiseStoreId },
        data: { storeStatusCode: 'CLOSED' },
      });
      try {
        expect(
          (await titlesOf('storeTypes=FRANCHISE')).map((i) => i.title),
        ).not.toContain('전체 배정');
        for (const query of [`storeIds=${franchiseStoreId}`, ''])
          expect((await titlesOf(query)).map((i) => i.title)).toContain(
            '전체 배정',
          );
      } finally {
        await prisma.store.update({
          where: { storeId: franchiseStoreId },
          data: { storeStatusCode: 'OPERATING' },
        });
      }
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

  // 탭 BP(X-Bp-Code-Id) — 플랫폼 계정은 고른 고객 BP 의 TO-DO 를 다룬다. 헤더가 없으면 /todos 는 범위를 보기 전에 400,
  // 직원 상세의 TO-DO 영역은 직원 단위라 404(근로계약 상세와 같다). BP · 가맹 계정은 그대로다.
  it('플랫폼 마스터 — 고른 BP 의 TO-DO 만, 헤더가 없으면 /todos 400 · 직원 상세 TO-DO 404. BP 계정은 그대로', async () => {
    const as = async (
      sub: number,
      method: 'get' | 'post' | 'patch' | 'delete',
      path: string,
      bp?: number,
      body?: object,
    ) => {
      const req = request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${await adminToken(sub)}`);
      if (bp !== undefined) req.set('X-Bp-Code-Id', String(bp));
      return body === undefined ? req : req.send(body);
    };
    const body = todoBody({
      storeId: directStoreId,
      assigneeType: 'ALL',
      executionMode: 'EACH',
      title: '플랫폼 배정',
    });
    const created = await as(pmId, 'post', '/todos', bpCodeId, body);
    expect(created.status).toBe(201);
    const [todoId] = (created.body as { todoIds: number[] }).todoIds;
    const titles = (res: { body: unknown }) =>
      (res.body as { items: { title: string }[] }).items.map((i) => i.title);
    const list = await as(pmId, 'get', '/todos?pageSize=100', bpCodeId);
    expect(list.status).toBe(200);
    expect(titles(list)).toContain('플랫폼 배정');
    // 본사에게 가려지는 가맹 직원도 플랫폼 계정에게는 가리지 않는다(WHALEERP-618)
    expect(
      (
        await as(
          pmId,
          'get',
          '/todos/assignable-staff?storeId=' + franchiseStoreId,
          bpCodeId,
        )
      ).status,
    ).toBe(200);
    expect((await as(pmId, 'get', `/todos/${todoId}`, bpCodeId)).status).toBe(
      200,
    );
    // 고객 BP 의 TO-DO 를 고치면 응답도 그 BP 로 다시 읽어 200 · 고친 값이다(api #253 리뷰)
    const patched = await as(pmId, 'patch', `/todos/${todoId}`, bpCodeId, {
      title: '플랫폼 수정',
    });
    expect([patched.status, (patched.body as { title: string }).title]).toEqual(
      [200, '플랫폼 수정'],
    );
    const staffTodos = `/staff-members/${direct1.staffMemberId}/todos`;
    expect((await as(pmId, 'get', staffTodos, bpCodeId)).status).toBe(200);

    // 다른 고객 BP 를 고르면 이 BP 의 TO-DO · 직원은 범위 밖
    const other = await as(pmId, 'get', '/todos?pageSize=100', otherBpCodeId);
    expect([other.status, titles(other)]).toEqual([200, []]);
    expect(
      (await as(pmId, 'get', `/todos/${todoId}`, otherBpCodeId)).status,
    ).toBe(404);
    expect((await as(pmId, 'get', staffTodos, otherBpCodeId)).status).toBe(404);

    // 헤더 없음 — /todos 는 400, 직원 상세 TO-DO 는 404
    for (const [method, path, payload] of [
      ['get', '/todos'],
      ['get', `/todos/${todoId}`],
      ['post', '/todos', body],
      ['patch', `/todos/${todoId}`, { title: '바꿈' }],
      ['delete', `/todos/${todoId}`],
    ] as const) {
      const res = await as(pmId, method, path, undefined, payload);
      expect([
        path,
        res.status,
        (res.body as { message: string }).message,
      ]).toEqual([path, 400, 'TO-DO 를 볼 BP 를 골라 주세요.']);
    }
    expect((await as(pmId, 'get', staffTodos)).status).toBe(404);

    // BP 계정 — 자기 BP 헤더는 헤더 없을 때와 같고, 남의 BP 헤더는 가드의 403
    const own = await as(bmId, 'get', '/todos?pageSize=100', bpCodeId);
    expect(own.status).toBe(200);
    expect(own.body).toEqual(
      (await as(bmId, 'get', '/todos?pageSize=100')).body,
    );
    expect((await as(bmId, 'get', '/todos', otherBpCodeId)).status).toBe(403);
    expect(
      (await as(pmId, 'delete', `/todos/${todoId}`, bpCodeId)).status,
    ).toBe(200);
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
      title: 'TO-DO 수행 예정 알림',
    });
    expect(rows[0].notificationRecipients).toHaveLength(1);
    expect(rows[0].notificationRecipients[0].accountId).toBe(direct1.accountId);
    // 앱 푸시는 발송 대기 행만 — 보낸 시각 · 결과가 비어 있다
    expect(rows[0].notificationRecipients[0].notificationDeliveries).toEqual([
      expect.objectContaining({ channel: 'PUSH', sentAt: null, result: null }),
    ]);
  });
});
