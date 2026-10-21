import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstToday } from '../src/staff-members/kst-date';

// 근무스케줄 등록 · 수정 · 삭제를 실제 DB 로 확인한다(#198) — 겹침 금지 EXCLUDE 와 맞닿는 근무, 자정 넘김, 계약 기간 ·
// 가입 · 퇴직일 · 본사 제공 동의 판정, 변경 이력. 목으로는 쿼리 모양만 보인다.
describe('근무스케줄 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let bpCodeId: number;
  let directStoreId: number;
  let franchiseStoreId: number;
  let bmId: number;
  /** 직영 · 가입 완료 · 기간의 정함이 없는 계약, 수요일 09:00-18:00 휴게 12:00-13:00 */
  let directId: number;
  /** 직영 · 같은 사람의 다른 레코드처럼 쓰는 둘째 직원 */
  let direct2Id: number;
  /** 직영 · 종이 계약 체결 완료지만 가입 전 */
  let unjoinedId: number;
  /** 직영 · 계약이 오늘+10 에 끝난다 */
  let endingId: number;
  /** 직영 · 퇴직일 오늘+5 */
  let retiringId: number;
  /** 가맹 · 본사 제공 동의 안 함 */
  let unconsentedId: number;
  /** 직영 · 계약이 체결된 뒤 종료(ENDED, 이력에 SIGNED) */
  let endedAfterSignId: number;
  /** 직영 · 계약이 날인 전에 종료(ENDED, 이력에 SIGNED 없음) */
  let endedBeforeSignId: number;
  const staffIds: number[] = [];
  const accountIds: number[] = [];
  const today = kstToday();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const day = (offset: number) => iso(addDays(today, offset));

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
        tradeName: '근무스케줄 테스트 BP',
      },
    }));
    const store = (offset: number, storeTypeCode: string) =>
      prisma.store.create({
        data: {
          storeCode: `ST${(n + offset) % 1_000_000}`,
          bpCodeId,
          storeTypeCode,
          name: `근무스케줄 ${storeTypeCode}`,
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
        loginId: `sched${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));

    directId = await staff(directStoreId, '직영하나');
    direct2Id = await staff(directStoreId, '직영둘');
    unjoinedId = await staff(directStoreId, '가입전', { joined: false });
    endingId = await staff(directStoreId, '계약끝', { endOffset: 10 });
    retiringId = await staff(directStoreId, '퇴직예정');
    await prisma.staffMember.update({
      where: { staffMemberId: retiringId },
      data: { retiredDate: addDays(today, 5) },
    });
    unconsentedId = await staff(franchiseStoreId, '동의안함');
    // 체결된 뒤 계약 기간이 끝나 종료된 계약(종료일 어제)
    endedAfterSignId = await staff(directStoreId, '체결뒤종료', {
      endOffset: -1,
    });
    endedBeforeSignId = await staff(directStoreId, '날인전종료');
    // 상태만 바꾸고 이력을 손으로 남긴다 — 체결을 거쳤는지는 이력의 SIGNED 로 가른다(PAY-11 v181 A안)
    const end = async (
      staffMemberId: number,
      path: ('PENDING_SIGNATURE' | 'SIGNED' | 'ENDED')[],
    ) => {
      const { contractId } = await prisma.contract.findFirstOrThrow({
        where: { staffMemberId },
      });
      await prisma.contract.update({
        where: { contractId },
        data: { status: 'ENDED' },
      });
      await prisma.contractStatusHistory.createMany({
        data: path.map((toStatus) => ({
          contractId,
          toStatus,
          actor: 'ADMIN' as const,
        })),
      });
    };
    await end(endedAfterSignId, ['PENDING_SIGNATURE', 'SIGNED', 'ENDED']);
    await end(endedBeforeSignId, ['PENDING_SIGNATURE', 'ENDED']);
  });

  /** 체결 완료 계약이 있는 직원 레코드. 계약은 오늘−30 부터, 근무일은 수요일 09:00-18:00 휴게 12:00-13:00 */
  async function staff(
    storeId: number,
    name: string,
    { joined = true, endOffset }: { joined?: boolean; endOffset?: number } = {},
  ): Promise<number> {
    const n = randomInt(10_000_000, 99_999_999);
    let accountId: number | null = null;
    if (joined) {
      ({ accountId } = await prisma.account.create({
        data: {
          email: `sched-${n}@test.invalid`,
          passwordHash: '!',
          realName: name,
          birthDate: new Date('1990-01-01'),
          phone: `010${n}`,
          status: 'JOINED',
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
    const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
    await prisma.contract.create({
      data: {
        staffMemberId,
        storeId,
        employmentType: 'PART_TIME',
        contractMethod: joined ? 'ELECTRONIC' : 'PAPER',
        startDate: addDays(today, -30),
        endDate: endOffset === undefined ? null : addDays(today, endOffset),
        isHealthPensionInsured: false,
        isEmploymentInjuryInsured: false,
        status: 'SIGNED',
        createdBy: bmId,
        contractWorkDays: {
          create: {
            weekday: 'WED',
            startTime: t('09:00'),
            endTime: t('18:00'),
            breakStartTime: t('12:00'),
            breakEndTime: t('13:00'),
          },
        },
      },
    });
    return staffMemberId;
  }

  afterAll(async () => {
    if (!prisma) return;
    const schedules = await prisma.workSchedule.findMany({
      where: { staffMemberId: { in: staffIds } },
      select: { workScheduleId: true },
    });
    const ids = schedules.map((s) => s.workScheduleId);
    await prisma.workScheduleHistory.deleteMany({
      where: { workScheduleId: { in: ids } },
    });
    await prisma.workSchedule.deleteMany({
      where: { workScheduleId: { in: ids } },
    });
    await prisma.contractStatusHistory.deleteMany({
      where: { contract: { staffMemberId: { in: staffIds } } },
    });
    await prisma.contractWorkDay.deleteMany({
      where: { contract: { staffMemberId: { in: staffIds } } },
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
  const asAdmin = async (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await adminToken()}`);
    return body === undefined ? req : req.send(body);
  };
  const post = (
    staffMemberId: number,
    workDate: string,
    s: string,
    e: string,
    breakMinutes = 0,
  ) =>
    asAdmin('post', '/work-schedules', {
      staffMemberId,
      workDate,
      startTime: s,
      endTime: e,
      breakMinutes,
    });

  it('자정을 넘는 근무를 받고, 근무일은 시작한 날이며, 등록 이력이 남는다', async () => {
    const res = await post(directId, day(1), '22:00', '06:00', 30);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workDate: day(1),
      startTime: '22:00',
      endTime: '06:00',
      breakMinutes: 30,
      storeId: directStoreId,
    });
    const body = res.body as {
      workScheduleId: number;
      startAt: string;
      endAt: string;
    };
    expect(
      new Date(body.endAt).getTime() - new Date(body.startAt).getTime(),
    ).toBe(8 * 3600_000);
    const histories = await prisma.workScheduleHistory.findMany({
      where: { workScheduleId: body.workScheduleId },
    });
    expect(histories).toEqual([
      expect.objectContaining({ changeType: 'CREATED', changedBy: bmId }),
    ]);
  });

  it('같은 직원 레코드끼리 겹치면 409, 맞닿는 근무 · 쪼갠 근무 · 다른 직원은 받는다', async () => {
    expect((await post(directId, day(2), '09:00', '13:00')).status).toBe(201);
    const hit = await post(directId, day(2), '12:30', '15:00');
    expect(hit.status).toBe(409);
    expect(hit.body).toMatchObject({ code: 'WORK_SCHEDULE_OVERLAP' });
    expect((await post(directId, day(2), '13:00', '15:00')).status).toBe(201); // 맞닿음
    expect((await post(directId, day(2), '18:00', '22:00')).status).toBe(201); // 쪼갠 근무
    expect((await post(direct2Id, day(2), '09:00', '13:00')).status).toBe(201); // 다른 직원
  });

  it('자정 넘김이 다음 날 근무와 겹치면 409', async () => {
    expect((await post(directId, day(3), '05:00', '09:00')).status).toBe(201);
    const res = await post(directId, day(2), '23:00', '05:30');
    expect(res.status).toBe(409);
  });

  it('DB 겹침 금지 제약이 서버 검사를 건너뛴 저장도 막고, 오류에 제약 이름이 실린다(동시 저장 → 409 판정 근거)', async () => {
    const existing = await prisma.workSchedule.findFirstOrThrow({
      where: { staffMemberId: directId, isDeleted: false },
    });
    await expect(
      prisma.workSchedule.create({
        data: {
          staffMemberId: directId,
          storeId: directStoreId,
          startAt: existing.startAt,
          endAt: existing.endAt,
          createdBy: bmId,
        },
      }),
    ).rejects.toThrow('work_schedules_no_overlap');
  });

  it('30분 단위가 아니거나 24시간짜리 · 휴게가 근무 길이 이상이면 400', async () => {
    expect((await post(directId, day(4), '09:15', '18:00')).status).toBe(400);
    expect((await post(directId, day(4), '09:00', '09:00')).status).toBe(400);
    expect((await post(directId, day(4), '09:00', '10:00', 60)).status).toBe(
      400,
    );
    expect((await post(directId, day(4), '18:00', '24:00')).status).toBe(201);
  });

  it('근무일에 체결 완료 계약이 없으면 400 — 계약 종료일 당일은 받는다', async () => {
    const out = await post(endingId, day(11), '09:00', '18:00');
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'WORK_SCHEDULE_NO_CONTRACT' });
    expect((await post(endingId, day(10), '09:00', '18:00')).status).toBe(201);
    expect((await post(endingId, day(-31), '09:00', '18:00')).status).toBe(400);
  });

  it('체결된 뒤 종료된 계약의 기간은 받고, 날인 전에 종료된 계약은 받지 않는다(PAY-11 v181 A안)', async () => {
    expect(
      (await post(endedAfterSignId, day(-5), '09:00', '18:00')).status,
    ).toBe(201);
    const res = await post(endedBeforeSignId, day(-5), '09:00', '18:00');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WORK_SCHEDULE_NO_CONTRACT' });
  });

  it('지난 날짜도 계약 기간 안이면 경고 없이 받는다', async () => {
    expect((await post(endingId, day(-10), '09:00', '18:00')).status).toBe(201);
  });

  it('가입 전(종이 계약 체결 완료) 직원은 400', async () => {
    const res = await post(unjoinedId, day(1), '09:00', '18:00');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WORK_SCHEDULE_NOT_JOINED' });
  });

  it('퇴직일 뒤 날짜는 400, 퇴직일 당일은 받는다(CTR-24)', async () => {
    const res = await post(retiringId, day(6), '09:00', '18:00');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WORK_SCHEDULE_AFTER_RETIREMENT' });
    expect((await post(retiringId, day(5), '09:00', '18:00')).status).toBe(201);
  });

  it('BP 마스터는 동의 없는 가맹 직원에게 등록하지 못하고, 선택지에도 없다(ATT-30)', async () => {
    expect((await post(unconsentedId, day(1), '09:00', '18:00')).status).toBe(
      400,
    );
    const list = await asAdmin(
      'get',
      `/work-schedules/assignable-staff?storeId=${franchiseStoreId}&workDate=${day(1)}`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ items: [] });
  });

  it('선택지는 그 근무일에 받을 수 있는 직원만 — 가입 전 · 계약 끝 · 퇴직일 뒤는 빠진다', async () => {
    const res = await asAdmin(
      'get',
      `/work-schedules/assignable-staff?storeId=${directStoreId}&workDate=${day(20)}`,
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { items: { staffMemberId: number }[] }).items.map(
      (i) => i.staffMemberId,
    );
    expect(ids.sort()).toEqual([directId, direct2Id].sort());
  });

  it('기본값은 그 요일의 계약 근무시간, 휴게는 길이(분) — 계약 근무일이 아니면 빈 값', async () => {
    // 오늘부터 7일 안의 수요일 · 목요일
    const offsetOf = (dow: number) => {
      for (let i = 0; i < 7; i += 1)
        if (addDays(today, i).getUTCDay() === dow) return i;
      return 0;
    };
    const wed = await asAdmin(
      'get',
      `/work-schedules/defaults?staffMemberId=${directId}&workDate=${day(offsetOf(3))}`,
    );
    expect(wed.body).toEqual({
      startTime: '09:00',
      endTime: '18:00',
      breakMinutes: 60,
    });
    const thu = await asAdmin(
      'get',
      `/work-schedules/defaults?staffMemberId=${directId}&workDate=${day(offsetOf(4))}`,
    );
    expect(thu.body).toEqual({
      startTime: null,
      endTime: null,
      breakMinutes: null,
    });
  });

  it('수정은 바뀐 값으로 다시 보고 변경 전후 이력을 남기고, 삭제하면 같은 시간에 다시 넣을 수 있다', async () => {
    const created = await post(direct2Id, day(7), '09:00', '13:00');
    const id = (created.body as { workScheduleId: number }).workScheduleId;

    const moved = await asAdmin('patch', `/work-schedules/${id}`, {
      workDate: day(7),
      startTime: '10:00',
      endTime: '14:00',
      breakMinutes: 0,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ startTime: '10:00', endTime: '14:00' });

    const removed = await asAdmin('delete', `/work-schedules/${id}`);
    expect(removed.status).toBe(200);
    expect((await asAdmin('delete', `/work-schedules/${id}`)).status).toBe(404);
    // 지운 근무스케줄은 고치지 않는다(잠그고 다시 읽어 404)
    expect(
      (
        await asAdmin('patch', `/work-schedules/${id}`, {
          workDate: day(7),
          startTime: '11:00',
          endTime: '14:00',
          breakMinutes: 0,
        })
      ).status,
    ).toBe(404);
    expect((await post(direct2Id, day(7), '10:00', '14:00')).status).toBe(201);

    const histories = await prisma.workScheduleHistory.findMany({
      where: { workScheduleId: id },
      orderBy: { workScheduleHistoryId: 'asc' },
    });
    expect(histories.map((h) => h.changeType)).toEqual([
      'CREATED',
      'UPDATED',
      'DELETED',
    ]);
    expect(histories[1].beforeValue).toMatchObject({ breakMinutes: 0 });
    expect(histories[2].afterValue).toBeNull();
  });

  it('없는 · 범위 밖 근무스케줄과 이상한 ID 는 404', async () => {
    expect(
      (
        await asAdmin('patch', '/work-schedules/2147483647', {
          workDate: day(1),
          startTime: '09:00',
          endTime: '10:00',
          breakMinutes: 0,
        })
      ).status,
    ).toBe(404);
    expect((await asAdmin('delete', '/work-schedules/abc')).status).toBe(404);
  });
});
