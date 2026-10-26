// 응답 본문(supertest 의 any)을 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { dateOnly } from '../src/common/date-only';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstDayStart, kstToday } from '../src/staff-members/kst-date';

// BP 휴일 관리(MN000015)를 실제 DB 로 확인한다 — 경로로 찾는 메뉴 권한 · 대상 BP, 점포 기간 행(마이그레이션
// 20261026135250), 잠금과 updatedAt 으로 막는 동시 수정, 날짜 계산이 DB 의 @db.Date 와 맞는지.
describe('BP 휴일 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 990_000);
  const today = kstToday();
  const day = (offset: number) => dateOnly(addDays(today, offset));

  const bpIds: number[] = [];
  const adminIds: number[] = [];
  const storeIds: number[] = [];
  const groupIds: number[] = [];
  let bpId: number;
  let otherBpId: number;
  let storeA: number;
  let storeB: number;
  let storeC: number;
  let bmId: number;
  let fmId: number;
  let paId: number;
  let otherBmId: number;
  let baNoUpdateId: number;

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    // 동시 요청 시험이 있다 — 띄워 두지 않으면 supertest 가 요청마다 서버를 연다.
    await app.listen(0);
    prisma = app.get(PrismaService);

    const bp = async (code: string) => {
      const { bpCodeId } = await prisma.bpCode.create({
        data: {
          bpCode: code,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: `휴일 테스트 ${code}`,
        },
      });
      bpIds.push(bpCodeId);
      return bpCodeId;
    };
    bpId = await bp(`BP${n}`);
    otherBpId = await bp(`BP${n + 1}`);

    const store = async (k: number, name: string) => {
      const { storeId } = await prisma.store.create({
        data: {
          storeCode: `ST${String(n + k).padStart(6, '0')}`,
          bpCodeId: bpId,
          storeTypeCode: 'DIRECT',
          name,
          storeStatusCode: 'OPERATING',
        },
      });
      storeIds.push(storeId);
      return storeId;
    };
    storeA = await store(0, `가 판교점 ${n}`);
    storeB = await store(1, `나 서초점 ${n}`);
    storeC = await store(2, `다 성수점 ${n}`);

    const group = (roleCode: string) =>
      prisma.roleGroup.findFirstOrThrow({ where: { roleCode } });
    const [pm, bm, fm] = await Promise.all([
      group('PM000001'),
      group('BM000001'),
      group('FM000001'),
    ]);
    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const admin = async (
      prefix: string,
      roleTypeCode: string,
      roleGroupId: number,
      bpCodeId: number,
      isAllStores = true,
    ) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${prefix}${n}`,
          name: `시험${prefix}`,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };
    bmId = await admin('bhbm', 'BM', bm.roleGroupId, bpId);
    // 가맹 마스터 — 판교점(A)만 맡는다
    fmId = await admin('bhfm', 'FM', fm.roleGroupId, bpId, false);
    await prisma.adminStoreMapping.create({
      data: { adminAccountId: fmId, storeId: storeA },
    });
    paId = await admin('bhpa', 'PA', pm.roleGroupId, platformBp.bpCodeId);
    otherBmId = await admin('bhob', 'BM', bm.roleGroupId, otherBpId);

    // BP 휴일 관리를 조회 · 삭제만 하고 수정은 못 하는 BA 그룹(전체 점포)
    const { roleGroupId: noUpdateGroup } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n}`,
        bpCodeId: bpId,
        roleTypeCode: 'BA',
        name: `휴일 수정 없음 ${n}`,
      },
    });
    groupIds.push(noUpdateGroup);
    const { menuId } = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000015' },
    });
    await prisma.roleGroupMenu.create({
      data: {
        roleGroupId: noUpdateGroup,
        menuId,
        isReadable: true,
        isDeletable: true,
      },
    });
    baNoUpdateId = await admin('bhbn', 'BA', noUpdateGroup, bpId);
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      const holidayIds = (
        await prisma.bpHoliday.findMany({
          where: { bpCodeId: { in: bpIds } },
          select: { bpHolidayId: true },
        })
      ).map((h) => h.bpHolidayId);
      const byHoliday = { where: { bpHolidayId: { in: holidayIds } } };
      await prisma.bpHolidayChangeHistory.deleteMany(byHoliday);
      await prisma.holidayStoreMapping.deleteMany(byHoliday);
      await prisma.holidayExcludedStore.deleteMany(byHoliday);
      await prisma.bpHoliday.deleteMany(byHoliday);
      await prisma.adminStoreMapping.deleteMany({
        where: { adminAccountId: { in: adminIds } },
      });
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: { in: adminIds } },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: { in: adminIds } },
      });
      await prisma.roleGroupMenu.deleteMany({
        where: { roleGroupId: { in: groupIds } },
      });
      await prisma.roleGroup.deleteMany({
        where: { roleGroupId: { in: groupIds } },
      });
      await prisma.store.deleteMany({ where: { storeId: { in: storeIds } } });
      await prisma.bpCode.deleteMany({ where: { bpCodeId: { in: bpIds } } });
    } finally {
      // 정리가 실패해도 앱을 닫는다 — 닫지 않으면 jest 가 끝나지 않는다.
      await app?.close();
    }
  });

  // 관리자 토큰은 살아 있는 관리자 세션(admin_sessions)이 있어야 가드를 통과한다.
  const tokenOf = async (sub: number) =>
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
  const call = async (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    sub: number,
    body?: object,
    bpHeader?: number,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    if (bpHeader) req.set('X-Bp-Code-Id', String(bpHeader));
    return body ? req.send(body) : req;
  };
  const detail = async (id: number, sub = bmId) =>
    (await call('get', `/bp-holidays/${id}`, sub)).body;

  /** 2주 전부터 매주 · 판교점(A) · 서초점(B) — API 는 지난 시작일을 받지 않아 DB 에 바로 넣는다. */
  const ongoingWeekly = async () => {
    const start = addDays(today, -14);
    const { bpHolidayId } = await prisma.bpHoliday.create({
      data: {
        bpCodeId: bpId,
        isAllStores: false,
        holidayTypeCode: 'REPEAT',
        startDate: start,
        holidayRepeatTypeCode: 'WEEKLY',
        repeatEndType: 'NONE',
        name: '정기휴무',
        storeMappings: {
          createMany: {
            data: [
              { storeId: storeA, effectiveStartDate: start },
              { storeId: storeB, effectiveStartDate: start },
            ],
          },
        },
      },
    });
    return bpHolidayId;
  };
  const weeklyForm = (id: number, over: object = {}) =>
    detail(id).then((h) => ({
      name: h.name,
      description: h.description,
      holidayTypeCode: h.holidayTypeCode,
      startDate: h.startDate,
      holidayRepeatTypeCode: h.holidayRepeatTypeCode,
      repeatEndType: h.repeatEndType,
      isAllStores: false,
      storeIds: h.stores.map((s: { storeId: number }) => s.storeId),
      updatedAt: h.updatedAt,
      ...over,
    }));

  describe('등록', () => {
    let upcomingId: number;

    it('특정 점포 기간 휴일을 등록하면 대상 점포가 휴일 시작일부터 묶인다', async () => {
      const res = await call('post', '/bp-holidays', bmId, {
        name: '임시 휴무',
        holidayTypeCode: 'PERIOD',
        startDate: day(1),
        endDate: day(3),
        isAllStores: false,
        storeIds: [storeA, storeB],
      });
      expect(res.status).toBe(201);
      upcomingId = res.body.bpHolidayId;
      const rows = await prisma.holidayStoreMapping.findMany({
        where: { bpHolidayId: upcomingId },
        orderBy: { storeId: 'asc' },
      });
      expect(
        rows.map((r) => [
          r.storeId,
          dateOnly(r.effectiveStartDate),
          r.effectiveEndDate,
        ]),
      ).toEqual([
        [storeA, day(1), null],
        [storeB, day(1), null],
      ]);
      const h = await detail(upcomingId);
      expect(h).toMatchObject({
        state: 'UPCOMING',
        endDate: day(3),
        actions: { canUpdate: true, canTerminate: false, canDelete: true },
      });
      expect(h.histories.map((x: { field: string }) => x.field)).toEqual([
        '등록',
      ]);
    });

    it('월 목록에 계산한 날짜마다 한 줄씩 나온다', async () => {
      const target = addDays(today, 1);
      const res = await call(
        'get',
        `/bp-holidays?year=${target.getUTCFullYear()}&month=${target.getUTCMonth() + 1}&name=${encodeURIComponent('임시 휴무')}`,
        bmId,
      );
      expect(res.status).toBe(200);
      const mine = res.body.items.filter(
        (r: { bpHolidayId: number }) => r.bpHolidayId === upcomingId,
      );
      // 3일 기간이 달을 넘길 수 있어 이 달 안의 날짜만 센다
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine[0]).toMatchObject({
        date: day(1),
        target: { isAllStores: false, otherStoreCount: 1 },
        isPast: false,
      });
    });

    it('겹치는 휴일 확인은 같은 점포 · 같은 날짜의 기존 휴일을 알려 주고 저장은 막지 않는다', async () => {
      const res = await call('post', '/bp-holidays/overlaps', bmId, {
        name: '하루 휴무',
        holidayTypeCode: 'DAY',
        startDate: day(2),
        isAllStores: false,
        storeIds: [storeA, storeC],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        storeCount: 1,
        dateCount: 1,
        stores: [
          {
            storeId: storeA,
            dates: [{ date: day(2), holidayNames: ['임시 휴무'] }],
          },
        ],
      });
    });

    it('지난 시작일 · 기간의 종료일 누락은 400', async () => {
      const base = { name: '휴무', isAllStores: false, storeIds: [storeA] };
      expect(
        (
          await call('post', '/bp-holidays', bmId, {
            ...base,
            holidayTypeCode: 'DAY',
            startDate: day(-1),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('post', '/bp-holidays', bmId, {
            ...base,
            holidayTypeCode: 'PERIOD',
            startDate: day(1),
          })
        ).status,
      ).toBe(400);
    });

    it('맡은 점포가 판교점뿐인 가맹 마스터는 전체 점포 휴일 · 서초점 휴일을 등록하지 못한다(403)', async () => {
      const base = { name: '휴무', holidayTypeCode: 'DAY', startDate: day(1) };
      expect(
        (
          await call('post', '/bp-holidays', fmId, {
            ...base,
            isAllStores: true,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('post', '/bp-holidays', fmId, {
            ...base,
            isAllStores: false,
            storeIds: [storeB],
          })
        ).status,
      ).toBe(403);
    });

    it('시작 전 휴일은 지울 수 있고, 지운 휴일은 상세에서 404 · 변경 이력에는 남는다', async () => {
      const updatedAt: string = (await detail(upcomingId)).updatedAt;
      // 읽은 값이 지났으면(그사이 누가 고쳤으면) 지우지 않는다 · updatedAt 없이는 400
      expect(
        (
          await call(
            'delete',
            `/bp-holidays/${upcomingId}?updatedAt=2000-01-01T00:00:00.000Z`,
            bmId,
          )
        ).status,
      ).toBe(409);
      expect(
        (await call('delete', `/bp-holidays/${upcomingId}`, bmId)).status,
      ).toBe(400);
      expect(
        (
          await call(
            'delete',
            `/bp-holidays/${upcomingId}?updatedAt=${encodeURIComponent(updatedAt)}`,
            bmId,
          )
        ).status,
      ).toBe(204);
      expect(
        (await call('get', `/bp-holidays/${upcomingId}`, bmId)).status,
      ).toBe(404);
      const res = await call('get', '/bp-holidays/histories', bmId);
      expect(res.status).toBe(200);
      expect(
        res.body.items
          .filter((h: { bpHolidayId: number }) => h.bpHolidayId === upcomingId)
          .map((h: { field: string }) => h.field),
      ).toEqual(['삭제', '등록']);
    });
  });

  describe('진행 중 휴일 — 점포 기간 · 강제 종료', () => {
    let id: number;
    beforeAll(async () => {
      id = await ongoingWeekly();
    });

    it('범위 밖 점포(서초점)가 묶인 휴일 — 가맹 마스터는 휴일명을 못 고치고(403) 맡은 판교점은 뺀다', async () => {
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            fmId,
            await weeklyForm(id, { name: '바꿈' }),
          )
        ).status,
      ).toBe(403);
      // 서초점을 빼려 하면 403
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            fmId,
            await weeklyForm(id, { storeIds: [storeA] }),
          )
        ).status,
      ).toBe(403);
      const res = await call(
        'put',
        `/bp-holidays/${id}`,
        fmId,
        await weeklyForm(id, { storeIds: [storeB] }),
      );
      expect(res.status).toBe(204);
      const a = await prisma.holidayStoreMapping.findFirstOrThrow({
        where: { bpHolidayId: id, storeId: storeA },
      });
      // 판교점은 어제까지 — 지난 날짜는 그대로 판교점도 쉬었다
      expect(dateOnly(a.effectiveEndDate)).toBe(day(-1));
    });

    it('진행 중 휴일의 반복 유형은 바꾸지 못하고(409), 읽은 updatedAt 이 지났으면 409', async () => {
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            bmId,
            await weeklyForm(id, { holidayRepeatTypeCode: 'DAILY' }),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            bmId,
            await weeklyForm(id, { updatedAt: '2000-01-01T00:00:00.000Z' }),
          )
        ).status,
      ).toBe(409);
    });

    it('같은 상세를 읽은 두 저장이 동시에 오면 하나만 들어간다', async () => {
      const form = await weeklyForm(id, { storeIds: [storeB, storeC] });
      const [r1, r2] = await Promise.all([
        call('put', `/bp-holidays/${id}`, bmId, form),
        call('put', `/bp-holidays/${id}`, bmId, form),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([204, 409]);
      const open = await prisma.holidayStoreMapping.findMany({
        where: { bpHolidayId: id, isDeleted: false, effectiveEndDate: null },
        orderBy: { storeId: 'asc' },
      });
      expect(
        open.map((r) => [r.storeId, dateOnly(r.effectiveStartDate)]),
      ).toEqual([
        [storeB, day(-14)],
        [storeC, day(0)],
      ]);
    });

    it('열린 기간은 휴일 · 점포마다 하나뿐이다(부분 고유 인덱스)', async () => {
      await expect(
        prisma.holidayStoreMapping.create({
          data: { bpHolidayId: id, storeId: storeC, effectiveStartDate: today },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('상세는 지금 열린 점포 · 다음 날짜 세 개 · 할 수 있는 것을 준다', async () => {
      const h = await detail(id, fmId);
      expect(h.state).toBe('ONGOING');
      expect(h.nextDates).toHaveLength(3);
      expect(h.stores.map((s: { storeId: number }) => s.storeId)).toEqual([
        storeB,
        storeC,
      ]);
      // 가맹 마스터는 판교점을 이미 뺐다 — 남은 점포는 모두 범위 밖이지만 지난 기간 덕분에 볼 수는 있다
      expect(h.actions).toMatchObject({
        canUpdate: false,
        canTerminate: false,
      });
    });

    it('강제 종료하면 어제까지로 끝나고, 끝난 휴일은 수정 · 삭제 · 다시 종료가 409', async () => {
      const before = await detail(id);
      expect(before.actions.canTerminate).toBe(true);
      expect(
        (
          await call('post', `/bp-holidays/${id}/terminate`, bmId, {
            updatedAt: before.updatedAt,
          })
        ).status,
      ).toBe(204);
      const row = await prisma.bpHoliday.findUniqueOrThrow({
        where: { bpHolidayId: id },
      });
      expect(row).toMatchObject({
        repeatEndType: 'UNTIL_DATE',
        repeatCount: null,
      });
      expect(dateOnly(row.repeatEndDate)).toBe(day(-1));
      const after = await detail(id);
      expect(after).toMatchObject({
        state: 'ENDED',
        actions: { canUpdate: false, canTerminate: false, canDelete: false },
      });
      expect(after.histories[0]).toMatchObject({ field: '강제 종료' });
      expect(
        (await call('put', `/bp-holidays/${id}`, bmId, await weeklyForm(id)))
          .status,
      ).toBe(409);
      expect(
        (
          await call(
            'delete',
            `/bp-holidays/${id}?updatedAt=${encodeURIComponent(String(after.updatedAt))}`,
            bmId,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call('post', `/bp-holidays/${id}/terminate`, bmId, {
            updatedAt: after.updatedAt,
          })
        ).status,
      ).toBe(409);
    });
  });

  describe('대상 BP', () => {
    it('플랫폼 계정은 BP 를 골라야 하고(400), 고르면 그 BP 의 휴일을 본다', async () => {
      const month = `year=${today.getUTCFullYear()}&month=${today.getUTCMonth() + 1}`;
      expect((await call('get', `/bp-holidays?${month}`, paId)).status).toBe(
        400,
      );
      const res = await call(
        'get',
        `/bp-holidays?${month}`,
        paId,
        undefined,
        bpId,
      );
      expect(res.status).toBe(200);
    });

    it('다른 BP 의 휴일은 상세 404 · 다른 BP 헤더는 403', async () => {
      const id = await ongoingWeekly();
      expect((await call('get', `/bp-holidays/${id}`, otherBmId)).status).toBe(
        404,
      );
      expect(
        (await call('get', `/bp-holidays/${id}`, otherBmId, undefined, bpId))
          .status,
      ).toBe(403);
    });
  });

  const monthOf = (date: Date) =>
    `year=${date.getUTCFullYear()}&month=${date.getUTCMonth() + 1}`;
  const rowsOf = async (date: Date, id: number, sub = bmId) =>
    (await call('get', `/bp-holidays?${monthOf(date)}`, sub)).body.items.filter(
      (r: { bpHolidayId: number }) => r.bpHolidayId === id,
    );
  const openRows = (table: 'mapping' | 'excluded', bpHolidayId: number) => {
    const where = { bpHolidayId, isDeleted: false };
    return table === 'mapping'
      ? prisma.holidayStoreMapping.findMany({
          where,
          orderBy: { storeId: 'asc' },
        })
      : prisma.holidayExcludedStore.findMany({
          where,
          orderBy: { storeId: 'asc' },
        });
  };

  describe('전체 점포 휴일 · 예외 점포', () => {
    const allForm = (id: number, over: object = {}) =>
      detail(id).then((h) => ({
        name: h.name,
        holidayTypeCode: h.holidayTypeCode,
        startDate: h.startDate,
        endDate: h.endDate,
        holidayRepeatTypeCode: h.holidayRepeatTypeCode,
        repeatEndType: h.repeatEndType,
        isAllStores: true,
        excludedStoreIds: h.stores.map((s: { storeId: number }) => s.storeId),
        updatedAt: h.updatedAt,
        ...over,
      }));

    it('예외 점포는 휴일 시작일부터 빠지고, 목록 · 상세가 그 수를 준다', async () => {
      const res = await call('post', '/bp-holidays', bmId, {
        name: '창립기념일',
        holidayTypeCode: 'PERIOD',
        startDate: day(1),
        endDate: day(2),
        isAllStores: true,
        excludedStoreIds: [storeB],
      });
      expect(res.status).toBe(201);
      const id = res.body.bpHolidayId;
      const rows = await openRows('excluded', id);
      expect(
        rows.map((r) => [r.storeId, dateOnly(r.effectiveStartDate)]),
      ).toEqual([[storeB, day(1)]]);
      // 오늘 등록한 점포 셋 중 서초점이 빠져 둘
      expect(
        (await call('get', `/bp-holidays/${id}?date=${day(1)}`, bmId)).body
          .appliedStoreCount,
      ).toBe(2);
      const [first] = await rowsOf(addDays(today, 1), id);
      expect(first).toMatchObject({
        date: day(1),
        target: { isAllStores: true, excludedStoreCount: 1 },
      });
    });

    it('진행 중인 전체 점포 휴일 — 예외를 풀면 어제까지, 새 예외는 오늘부터 · 가맹 마스터는 403', async () => {
      const start = addDays(today, -14);
      const { bpHolidayId: id } = await prisma.bpHoliday.create({
        data: {
          bpCodeId: bpId,
          isAllStores: true,
          holidayTypeCode: 'REPEAT',
          startDate: start,
          holidayRepeatTypeCode: 'WEEKLY',
          repeatEndType: 'NONE',
          name: '전체 정기휴무',
          excludedStores: {
            createMany: {
              data: [{ storeId: storeB, effectiveStartDate: start }],
            },
          },
        },
      });
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            fmId,
            await allForm(id, { excludedStoreIds: [storeA] }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            bmId,
            await allForm(id, { excludedStoreIds: [storeC] }),
          )
        ).status,
      ).toBe(204);
      const rows = await openRows('excluded', id);
      expect(
        rows.map((r) => [
          r.storeId,
          dateOnly(r.effectiveStartDate),
          dateOnly(r.effectiveEndDate),
        ]),
      ).toEqual([
        [storeB, day(-14), day(-1)],
        [storeC, day(0), null],
      ]);
      // 예외 점포도 열린 기간은 휴일 · 점포마다 하나
      await expect(
        prisma.holidayExcludedStore.create({
          data: { bpHolidayId: id, storeId: storeC, effectiveStartDate: today },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('목록의 날짜 범위', () => {
    it('달을 넘는 기간은 다음 달 목록에 넘어간 날짜만 나온다', async () => {
      // 다음 달 말일부터 3일
      const start = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0),
      );
      const res = await call('post', '/bp-holidays', bmId, {
        name: '달 넘김',
        holidayTypeCode: 'PERIOD',
        startDate: dateOnly(start),
        endDate: dateOnly(addDays(start, 2)),
        isAllStores: false,
        storeIds: [storeA],
      });
      expect(res.status).toBe(201);
      const next = addDays(start, 1);
      expect(
        (await rowsOf(next, res.body.bpHolidayId)).map(
          (r: { date: string }) => r.date,
        ),
      ).toEqual([dateOnly(next), dateOnly(addDays(start, 2))]);
    });

    it('지난달에 시작한 반복도 이번 달 목록에 나온다', async () => {
      const id = await ongoingWeekly();
      expect(
        (await rowsOf(today, id)).map((r: { date: string }) => r.date),
      ).toContain(day(0));
    });
  });

  describe('시작 전 휴일의 시작일 이동', () => {
    it('시작일을 옮기면 열린 점포 기간도 새 시작일로 — 같은 저장에서 더한 점포 포함 · 지난 날짜는 400', async () => {
      const res = await call('post', '/bp-holidays', bmId, {
        name: '이동 휴무',
        holidayTypeCode: 'PERIOD',
        startDate: day(3),
        endDate: day(6),
        isAllStores: false,
        storeIds: [storeA],
      });
      const id = res.body.bpHolidayId;
      const form = async (over: object) => ({
        name: '이동 휴무',
        holidayTypeCode: 'PERIOD',
        startDate: day(5),
        endDate: day(8),
        isAllStores: false,
        storeIds: [storeA, storeC],
        updatedAt: (await detail(id)).updatedAt,
        ...over,
      });
      expect(
        (await call('put', `/bp-holidays/${id}`, bmId, await form({}))).status,
      ).toBe(204);
      expect(
        (await openRows('mapping', id)).map((r) => [
          r.storeId,
          dateOnly(r.effectiveStartDate),
        ]),
      ).toEqual([
        [storeA, day(5)],
        [storeC, day(5)],
      ]);
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            bmId,
            await form({ startDate: day(-1) }),
          )
        ).status,
      ).toBe(400);
      // 오늘로 당기는 것은 된다
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            bmId,
            await form({ startDate: day(0) }),
          )
        ).status,
      ).toBe(204);
    });
  });

  describe('변경 이력의 범위', () => {
    it('일부 점포 사용자는 맡지 않은 점포만 대상인 휴일의 이력을 보지 못한다', async () => {
      const res = await call('post', '/bp-holidays', bmId, {
        name: '서초 전용',
        holidayTypeCode: 'DAY',
        startDate: day(4),
        isAllStores: false,
        storeIds: [storeB],
      });
      const id = res.body.bpHolidayId;
      const idsOf = async (sub: number) =>
        (
          await call('get', '/bp-holidays/histories?pageSize=200', sub)
        ).body.items.map((h: { bpHolidayId: number }) => h.bpHolidayId);
      expect(await idsOf(bmId)).toContain(id);
      expect(await idsOf(fmId)).not.toContain(id);
    });

    it('끝 날짜는 그날 한국 자정 전까지 — 다음 날 0시 이력은 빠진다', async () => {
      const id = await ongoingWeekly();
      const day3 = addDays(today, -3);
      const before = new Date(kstDayStart(addDays(day3, 1)).getTime() - 60_000); // 그날 23:59
      const after = kstDayStart(addDays(day3, 1)); // 다음 날 00:00
      await prisma.bpHolidayChangeHistory.createMany({
        data: [
          { bpHolidayId: id, field: 'e2e 경계 앞', changedAt: before },
          { bpHolidayId: id, field: 'e2e 경계 뒤', changedAt: after },
        ],
      });
      const res = await call(
        'get',
        `/bp-holidays/histories?from=${day(-3)}&to=${day(-3)}&pageSize=200`,
        bmId,
      );
      const fields = res.body.items
        .filter((h: { bpHolidayId: number }) => h.bpHolidayId === id)
        .map((h: { field: string }) => h.field);
      expect(fields).toEqual(['e2e 경계 앞']);
    });
  });

  describe('메뉴 권한 칸', () => {
    it('수정 칸이 없는 계정은 수정 · 점포 변경이 막히고(가드 403) 강제 종료는 된다', async () => {
      const id = await ongoingWeekly();
      const h = await detail(id, baNoUpdateId);
      expect(h.actions).toMatchObject({
        canUpdate: false,
        canUpdateStores: false,
        canTerminate: true,
      });
      expect(
        (
          await call(
            'put',
            `/bp-holidays/${id}`,
            baNoUpdateId,
            await weeklyForm(id),
          )
        ).status,
      ).toBe(403);
    });
  });
});
