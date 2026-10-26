// 응답 본문(supertest 의 any)을 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { kstToday } from '../src/staff-members/kst-date';

// 플랫폼 휴일 관리(MN000217)를 실제 DB 로 확인한다. 경로로 메뉴를 찾는 권한 판정 · 플랫폼 전용과, 마이그레이션이 넣은
// 공식 휴일을 날짜 범위로 읽는지는 단위 테스트가 목으로 가정만 하므로 여기서만 증명된다.
describe('플랫폼 휴일 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 990_000);
  const adminIds: number[] = [];
  const groupIds: number[] = [];
  /** 테스트가 넣은 동기화 이력 — 끝나면 지운다. */
  const logIds: number[] = [];

  let customerBpId: number | undefined;
  let pmId: number;
  let noRowId: number;
  let baId: number;
  let customerPmId: number;
  const nextYear = kstToday().getUTCFullYear() + 1;

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.listen(0);
    prisma = app.get(PrismaService);

    const { bpCodeId: platformBpId } = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    // PM000001 은 초기 데이터로 MN000217 조회 · 등록 · 수정 · 삭제 권한을 가진다.
    const { roleGroupId: pmGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'PM000001' },
    });
    const { menuId: holidayMenuId } = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000217' },
    });

    // 휴일 관리 행이 없는 PA 그룹
    const { roleGroupId: noRowGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n}`,
        bpCodeId: platformBpId,
        roleTypeCode: 'PA',
        name: `휴일 권한 없음 ${n}`,
      },
    });
    groupIds.push(noRowGroupId);
    // 휴일 관리 행을 가진 고객 BP 의 BA 그룹 — BP 계정은 행이 있어도 403
    ({ bpCodeId: customerBpId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '휴일 관리 테스트 BP',
      },
    }));
    const { roleGroupId: baGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n}`,
        bpCodeId: customerBpId,
        roleTypeCode: 'BA',
        name: `BA 휴일 ${n}`,
      },
    });
    groupIds.push(baGroupId);
    await prisma.roleGroupMenu.create({
      data: { roleGroupId: baGroupId, menuId: holidayMenuId, isReadable: true },
    });

    const admin = async (
      prefix: string,
      roleTypeCode: string,
      roleGroupId: number,
      bpCodeId = platformBpId,
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
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };
    pmId = await admin('phpm', 'PM', pmGroupId);
    noRowId = await admin('phno', 'PA', noRowGroupId);
    baId = await admin('phba', 'BA', baGroupId, customerBpId);
    customerPmId = await admin('phcp', 'PM', pmGroupId, customerBpId);
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      if (logIds.length)
        await prisma.publicHolidaySynchronizationLog.deleteMany({
          where: { synchronizationId: { in: logIds } },
        });
      if (adminIds.length) {
        await prisma.adminSession.deleteMany({
          where: { adminAccountId: { in: adminIds } },
        });
        await prisma.adminAccount.deleteMany({
          where: { adminAccountId: { in: adminIds } },
        });
      }
      if (groupIds.length) {
        await prisma.roleGroupMenu.deleteMany({
          where: { roleGroupId: { in: groupIds } },
        });
        await prisma.roleGroup.deleteMany({
          where: { roleGroupId: { in: groupIds } },
        });
      }
      if (customerBpId !== undefined)
        await prisma.bpCode.deleteMany({ where: { bpCodeId: customerBpId } });
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
  ) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);

  it('월을 주면 그 달의 공식 휴일을 날짜순으로 준다 — 마이그레이션의 2026년 추석', async () => {
    const res = await call('get', '/public-holidays?year=2026&month=9', pmId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      year: 2026,
      month: 9,
      total: 3,
      items: [
        { holidayDate: '2026-09-24', name: '추석 연휴', note: null },
        { holidayDate: '2026-09-25', name: '추석', note: null },
        { holidayDate: '2026-09-26', name: '추석 연휴', note: null },
      ],
    });
  });

  it('월이 없으면 그 해 전체를 주고, total 은 DB 의 그 해 건수와 같다', async () => {
    const res = await call('get', '/public-holidays?year=2025', pmId);
    expect(res.status).toBe(200);
    expect(res.body.month).toBeNull();
    expect(res.body.total).toBe(
      await prisma.publicHoliday.count({ where: { year: 2025 } }),
    );
    expect(res.body.items).toHaveLength(res.body.total);
    const dates = res.body.items.map(
      (h: { holidayDate: string }) => h.holidayDate,
    );
    expect(dates).toEqual([...dates].sort());
    // 한 날짜에 둘이 겹치면 이름을 이어 붙인 한 행이다.
    expect(res.body.items).toContainEqual(
      expect.objectContaining({
        holidayDate: '2025-05-05',
        name: '어린이날 · 부처님오신날',
      }),
    );
  });

  it('월 경계는 1일을 넣고 다음 달 1일을 뺀다 — 2월 설 연휴와 3월 1일 삼일절', async () => {
    const feb = await call('get', '/public-holidays?year=2026&month=2', pmId);
    expect(feb.status).toBe(200);
    expect(
      feb.body.items.map((h: { holidayDate: string }) => h.holidayDate),
    ).toEqual(['2026-02-16', '2026-02-17', '2026-02-18']);

    const mar = await call('get', '/public-holidays?year=2026&month=3', pmId);
    expect(mar.body).toMatchObject({
      total: 2,
      items: [
        { holidayDate: '2026-03-01', name: '삼일절', note: null },
        {
          holidayDate: '2026-03-02',
          name: '삼일절',
          note: '대체공휴일 — 삼일절',
        },
      ],
    });
  });

  it('해마다 마지막 동기화로 실패를 가리고, 최종 동기화는 성공한 것 중 마지막 시각이다', async () => {
    // 어떤 실제 이력보다 늦은 시각이라, DB 에 다른 이력이 있어도 이 행들이 최신이다.
    const at = (minutes: number) => new Date(Date.UTC(2099, 0, 1, 0, minutes));
    const thisYear = nextYear - 1;
    const rows = [
      // 올해: 실패 뒤 성공 — 덮였으니 failedYears 에 없다
      { year: thisYear, result: 'FAILED', synchronizedAt: at(0) },
      { year: thisYear, result: 'SUCCEEDED', synchronizedAt: at(1) },
      // 다음 해: 가장 늦은 행이 실패 — 최종 동기화가 이 시각이면 성공만 고르지 않은 것이다
      { year: nextYear, result: 'FAILED', synchronizedAt: at(2) },
    ] as const;
    for (const data of rows) {
      const { synchronizationId } =
        await prisma.publicHolidaySynchronizationLog.create({
          data: {
            ...data,
            error: data.result === 'FAILED' ? '시험 실패' : null,
          },
        });
      logIds.push(synchronizationId);
    }

    const res = await call('get', '/public-holidays?year=2026', pmId);
    expect(res.status).toBe(200);
    expect(res.body.synchronization).toEqual({
      lastSynchronizedAt: at(1).toISOString(),
      failedYears: [nextYear],
    });
  });

  it.each([
    ['연도 없음', '/public-holidays'],
    ['연도 1999', '/public-holidays?year=1999'],
    ['연도 2101', '/public-holidays?year=2101'],
    ['월 0', '/public-holidays?year=2026&month=0'],
    ['월 13', '/public-holidays?year=2026&month=13'],
  ])('%s 는 400', async (_, path) => {
    expect((await call('get', path, pmId)).status).toBe(400);
  });

  it.each([
    ['휴일 관리 행이 없는 PA', () => noRowId],
    ['행이 있어도 BP 쪽 BA', () => baId],
    ['플랫폼 BP 가 아닌 BP 의 PM', () => customerPmId],
  ])('%s 는 403', async (_, who) => {
    expect(
      (await call('get', '/public-holidays?year=2026', who())).status,
    ).toBe(403);
  });

  it.each([['post'], ['put'], ['delete']] as const)(
    '%s 로 공식 휴일을 바꾸는 길은 없다(404)',
    async (method) => {
      expect((await call(method, '/public-holidays', pmId)).status).toBe(404);
    },
  );
});
