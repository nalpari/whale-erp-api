import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ACCESS_DENIED_MESSAGE,
  READ_DENIED_MESSAGE,
} from '../src/auth/access-messages';
import {
  addDays,
  addMonths,
  kstDayStart,
  kstToday,
} from '../src/staff-members/kst-date';
import { STAFF_NOT_FOUND_MESSAGE } from '../src/staff-members/staff-menu';
import type { StaffMemberWorkScheduleListResponseDto } from '../src/staff-members/dto/staff-member-work-schedule-list.response.dto';

// 직원 상세의 근무스케줄 표(WHALEERP-185)를 실제 DB 로 확인한다. 정렬(근무일 내림차순 · 같은 날 시작 시각 오름차순)은 SQL
// 이라, 그리고 영역 메뉴 권한은 권한 그룹 · 메뉴 url 조인이라 목으로는 증명되지 않는다.
describe('직원 상세 근무스케줄 표 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const n = randomInt(100_000, 999_999);
  const pad = (v: number) => String(v % 1_000_000).padStart(6, '0');

  let bpCodeId: number;
  let otherBpId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let otherStoreId: number;
  let bmId: number; // BP 마스터(고정 그룹, 모든 메뉴 조회), 전체 점포
  let staffOnlyId: number; // 직원 정보 관리 조회만 — 근무스케줄 관리 조회 없음
  let noStaffReadId: number; // 근무스케줄 관리 조회만 — 직원 정보 관리 조회 없음
  const roleGroupIds: number[] = [];
  const adminIds: number[] = [];
  const staffIds: number[] = [];

  let jianId: number; // 직영 점포 — 기간별 근무스케줄
  let pagerId: number; // 직영 점포 — 페이지 나눔용 23건
  let maskedId: number; // 가맹 점포, 동의 없음 — BM 에게 가린다
  let otherBpStaffId: number; // 다른 BP 점포

  const today = kstToday();
  const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const at = (day: Date, hh: number, mm = 0) =>
    new Date(kstDayStart(day).getTime() + (hh * 60 + mm) * 60 * 1000);

  // 근무스케줄 — 이름으로 ID 를 찾는다
  const ids: Record<string, number> = {};
  const SCHEDULES: [string, Date, Date, boolean?, number?][] = [
    // 다음 주 월요일 한국 0시 00분 시작 — 이번 주에 들지 않는다(경계)
    ['nextMonday', at(addDays(monday, 7), 0), at(addDays(monday, 7), 4)],
    // 일요일 22시 ~ 다음 날 0시 — 근무일은 시작한 일요일. 끝이 0시 정각이라 위 행과 겹치지 않는다([시작, 끝) 범위)
    ['sunday22', at(addDays(monday, 6), 22), at(addDays(monday, 7), 0)],
    ['monday14', at(monday, 14), at(monday, 18)],
    // 한국 08시 = UTC 로 전날 23시 — 같은 한국 날짜의 14시보다 먼저여야 한다(ORDER BY 의 한국 날짜 변환). 휴게 30분 → 270분
    ['monday08', at(monday, 8), at(monday, 13), false, 30],
    ['deleted', at(addDays(monday, 2), 9), at(addDays(monday, 2), 13), true],
    ['day20', at(addDays(today, -20), 9), at(addDays(today, -20), 12)],
    // 28일 전 한국 0시 00분 시작은 최근 4주에 든다 · 그 전날 23시 59분 시작은 빠진다(경계)
    ['day28', at(addDays(today, -28), 0), at(addDays(today, -28), 1)],
    ['day29', at(addDays(today, -29), 23, 59), at(addDays(today, -28), 0)],
    ['day40', at(addDays(today, -40), 9), at(addDays(today, -40), 12)],
    ['month6', at(addMonths(today, -6), 9), at(addMonths(today, -6), 12)],
    ['month13', at(addMonths(today, -13), 9), at(addMonths(today, -13), 12)],
  ];

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

    const bp = async (code: number, name: string) =>
      (
        await prisma.bpCode.create({
          data: {
            bpCode: `BP${pad(code)}`,
            isPlatform: false,
            accountStatusCode: 'ACTIVE',
            tradeName: name,
          },
        })
      ).bpCodeId;
    const store = async (
      code: number,
      bp: number,
      storeTypeCode: string,
      name: string,
    ) =>
      (
        await prisma.store.create({
          data: {
            storeCode: `ST${pad(code)}`,
            bpCodeId: bp,
            storeTypeCode,
            name,
            storeStatusCode: 'OPERATING',
          },
        })
      ).storeId;
    bpCodeId = await bp(n, '근무표 테스트 BP');
    otherBpId = await bp(n + 1, '다른 BP');
    directStoreId = await store(n, bpCodeId, 'DIRECT', '근무표 직영점');
    franchiseStoreId = await store(
      n + 1,
      bpCodeId,
      'FRANCHISE',
      '근무표 가맹점',
    );
    otherStoreId = await store(n + 2, otherBpId, 'DIRECT', '다른 BP 점포');

    const admin = async (loginId: string, roleGroupId: number) => {
      const a = await prisma.adminAccount.create({
        data: {
          loginId,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode: 'BA',
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          isAllStores: true,
        },
      });
      adminIds.push(a.adminAccountId);
      return a.adminAccountId;
    };
    const fixedBm = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    bmId = await admin(`wsbm${n}`, fixedBm.roleGroupId);
    await prisma.adminAccount.update({
      where: { adminAccountId: bmId },
      data: { roleTypeCode: 'BM' },
    });
    const menuId = async (menuCode: string) =>
      (await prisma.menu.findFirstOrThrow({ where: { menuCode } })).menuId;
    const group = async (code: number, readable: string[]) => {
      const g = await prisma.roleGroup.create({
        data: {
          roleCode: `BA${pad(code)}`,
          bpCodeId,
          roleTypeCode: 'BA',
          name: `근무표 권한 ${code}`,
          menus: {
            create: await Promise.all(
              readable.map(async (m) => ({
                menuId: await menuId(m),
                isReadable: true,
              })),
            ),
          },
        },
      });
      roleGroupIds.push(g.roleGroupId);
      return g.roleGroupId;
    };
    // 직원 정보 관리(MN000005) · 근무스케줄 관리(MN000010)
    staffOnlyId = await admin(`wsstaff${n}`, await group(n, ['MN000005']));
    noStaffReadId = await admin(
      `wsnostaff${n}`,
      await group(n + 1, ['MN000010']),
    );

    const staff = async (storeId: number, name: string) => {
      const s = await prisma.staffMember.create({
        data: {
          storeId,
          name,
          phone: `010${randomInt(10_000_000, 99_999_999)}`,
          employmentType: 'FULL_TIME',
          jobTitle: '바리스타',
          joinStatus: 'DRAFT',
        },
      });
      staffIds.push(s.staffMemberId);
      return s.staffMemberId;
    };
    jianId = await staff(directStoreId, '서지안');
    pagerId = await staff(directStoreId, '페이지');
    maskedId = await staff(franchiseStoreId, '미동의');
    otherBpStaffId = await staff(otherStoreId, '다른BP');

    for (const [name, startAt, endAt, isDeleted, breakMinutes] of SCHEDULES)
      ids[name] = (
        await prisma.workSchedule.create({
          data: {
            staffMemberId: jianId,
            storeId: directStoreId,
            startAt,
            endAt,
            createdBy: bmId,
            isDeleted: isDeleted ?? false,
            breakMinutes: breakMinutes ?? 0,
          },
        })
      ).workScheduleId;
    // 페이지 — 오늘 30일 전부터 하루씩 거슬러 23건, 10~12시
    await prisma.workSchedule.createMany({
      data: Array.from({ length: 23 }, (_, i) => ({
        staffMemberId: pagerId,
        storeId: directStoreId,
        startAt: at(addDays(today, -30 - i), 10),
        endAt: at(addDays(today, -30 - i), 12),
        createdBy: bmId,
      })),
    });
    // 다른 직원의 근무스케줄은 들지 않는다
    await prisma.workSchedule.create({
      data: {
        staffMemberId: maskedId,
        storeId: franchiseStoreId,
        startAt: at(monday, 9),
        endAt: at(monday, 13),
        createdBy: bmId,
      },
    });
  });

  afterAll(async () => {
    const byStaff = { staffMemberId: { in: staffIds } };
    await prisma.workSchedule.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    const byGroup = { roleGroupId: { in: roleGroupIds } };
    await prisma.roleGroupMenu.deleteMany({ where: byGroup });
    await prisma.roleGroup.deleteMany({ where: byGroup });
    await prisma.store.deleteMany({
      where: {
        storeId: { in: [directStoreId, franchiseStoreId, otherStoreId] },
      },
    });
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpId] } },
    });
    await app.close();
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
  const get = async (path: string, sub = bmId) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
  const list = async (query: string, id = jianId) => {
    const res = await get(`/staff-members/${id}/work-schedules${query}`);
    expect(res.status).toBe(200);
    return res.body as StaffMemberWorkScheduleListResponseDto;
  };
  const namesOf = (body: StaffMemberWorkScheduleListResponseDto) =>
    body.items.map(
      (i) => Object.entries(ids).find(([, id]) => id === i.workScheduleId)?.[0],
    );

  it('기본(이번 주) — 날짜 · 근무지 · 시작 · 종료, 근무일 내림차순 · 같은 날은 시작 시각 순, 지운 것 · 다음 주 · 다른 직원은 빠진다', async () => {
    const body = await list('');
    expect(body.total).toBe(3);
    // 120(일 22~24) + 240(월 14~18) + 270(월 08~13, 휴게 30) — 지운 것은 세지 않는다
    expect(body.totalWorkMinutes).toBe(630);
    expect(namesOf(body)).toEqual(['sunday22', 'monday08', 'monday14']);
    expect(body.items[0]).toEqual({
      workScheduleId: ids.sunday22,
      workDate: ymd(addDays(monday, 6)),
      storeName: '근무표 직영점',
      startTime: '22:00',
      endTime: '00:00',
    });
    expect(body.items[1]).toMatchObject({
      workDate: ymd(monday),
      startTime: '08:00',
      endTime: '13:00',
    });
    expect(await list('?period=THIS_WEEK')).toEqual(body);
  });

  it('최근 4주 — 28일 전 한국 0시 00분 시작부터, 미래(다음 주 월요일 0시) 근무 포함 · 그 전날 23시 59분 시작은 빠진다', async () => {
    const body = await list('?period=LAST_4_WEEKS');
    expect(namesOf(body)).toEqual([
      'nextMonday',
      'sunday22',
      'monday08',
      'monday14',
      'day20',
      'day28',
    ]);
    expect(body.total).toBe(6);
    expect(body.totalWorkMinutes).toBe(630 + 240 + 180 + 60);
  });

  it('최근 3개월 · 최근 1년 · 전체 — 시작이 넓어지고 미래 근무는 늘 든다', async () => {
    const m3 = await list('?period=LAST_3_MONTHS');
    expect(namesOf(m3)).toEqual([
      'nextMonday',
      'sunday22',
      'monday08',
      'monday14',
      'day20',
      'day28',
      'day29',
      'day40',
    ]);
    const y1 = await list('?period=LAST_1_YEAR');
    expect(namesOf(y1)).toEqual([...namesOf(m3), 'month6']);
    expect(y1.total).toBe(9);
    const all = await list('?period=ALL');
    expect(namesOf(all)).toEqual([...namesOf(y1), 'month13']);
    expect(all.total).toBe(10);
    expect(all.totalWorkMinutes).toBe(1110 + 1 + 180 + 180 + 180);
  });

  it('페이지 — pageSize 20 이면 1쪽 20건 · 2쪽 3건, 넘긴 쪽은 빈 목록과 total', async () => {
    const p1 = await list('?period=ALL&page=1&pageSize=20', pagerId);
    expect([p1.items.length, p1.total]).toEqual([20, 23]);
    // 합계는 페이지가 아니라 기간 전체 — 23건 × 120분
    expect(p1.totalWorkMinutes).toBe(2760);
    expect(p1.items[0].workDate).toBe(ymd(addDays(today, -30)));
    const p2 = await list('?period=ALL&page=2&pageSize=20', pagerId);
    expect(p2.items.map((i) => i.workDate)).toEqual([
      ymd(addDays(today, -50)),
      ymd(addDays(today, -51)),
      ymd(addDays(today, -52)),
    ]);
    expect(p2.total).toBe(23);
    expect(p2.totalWorkMinutes).toBe(2760);
    const ids1 = new Set(p1.items.map((i) => i.workScheduleId));
    expect(p2.items.some((i) => ids1.has(i.workScheduleId))).toBe(false);
    expect(await list('?period=ALL&page=3', pagerId)).toEqual({
      items: [],
      total: 23,
      totalWorkMinutes: 2760,
    });
    // 기간 안에 없으면 0건 · 합계 0
    expect(await list('?period=THIS_WEEK', pagerId)).toEqual({
      items: [],
      total: 0,
      totalWorkMinutes: 0,
    });
    expect((await list('?period=ALL&pageSize=50', pagerId)).items).toHaveLength(
      23,
    );
  });

  it.each([
    '?period=BAD',
    '?period=this_week',
    '?pageSize=30',
    '?pageSize=0',
    '?page=0',
    '?page=abc',
  ])('잘못된 쿼리(%s)는 400', async (query) => {
    const res = await get(`/staff-members/${jianId}/work-schedules${query}`);
    expect(res.status).toBe(400);
  });

  it('근무스케줄 관리 조회가 없으면 403 「조회 권한이 없습니다.」 — 없는 직원 ID 도 같은 403(권한을 범위보다 먼저 본다)', async () => {
    for (const id of [jianId, 2147483646]) {
      const res = await get(`/staff-members/${id}/work-schedules`, staffOnlyId);
      expect([
        id,
        res.status,
        (res.body as { message: string }).message,
      ]).toEqual([id, 403, READ_DENIED_MESSAGE]);
    }
  });

  it('응답 순서 — 가드 403 → 쿼리 400 → ID 형식 404 → 영역 403', async () => {
    // 가드 403 이 쿼리 오류보다 먼저
    expect(
      (await get(`/staff-members/abc/work-schedules?period=BAD`, noStaffReadId))
        .status,
    ).toBe(403);
    // 쿼리 400 이 ID 형식 404 보다 먼저
    expect(
      (await get(`/staff-members/abc/work-schedules?period=BAD`)).status,
    ).toBe(400);
    // ID 형식 404 가 영역 403 보다 먼저
    const res = await get(`/staff-members/abc/work-schedules`, staffOnlyId);
    expect([res.status, (res.body as { message: string }).message]).toEqual([
      404,
      STAFF_NOT_FOUND_MESSAGE,
    ]);
  });

  it('직원 정보 관리 조회가 없으면 근무스케줄 관리 조회가 있어도 가드가 403', async () => {
    const res = await get(
      `/staff-members/${jianId}/work-schedules`,
      noStaffReadId,
    );
    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toBe(
      ACCESS_DENIED_MESSAGE,
    );
  });

  it('업무 범위 밖(다른 BP) · 본사 역할에게 동의 없는 가맹 점포 직원 · 없는 ID · ID 형식 오류는 같은 404', async () => {
    for (const id of [
      otherBpStaffId,
      maskedId,
      2147483646,
      'abc',
      '2147483648',
    ]) {
      const res = await get(`/staff-members/${id}/work-schedules`);
      expect([
        id,
        res.status,
        (res.body as { message: string }).message,
      ]).toEqual([id, 404, STAFF_NOT_FOUND_MESSAGE]);
    }
  });
});
