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
  /** 직영 · 기간의 정함이 없는 계약을 체결한 뒤 어제 대체로 종료(종료일 비어 있음) */
  let openEndedClosedId: number;
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
      endedAt?: Date,
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
          ...(toStatus === 'ENDED' && endedAt ? { changedAt: endedAt } : {}),
        })),
      });
    };
    await end(endedAfterSignId, ['PENDING_SIGNATURE', 'SIGNED', 'ENDED']);
    await end(endedBeforeSignId, ['PENDING_SIGNATURE', 'ENDED']);
    openEndedClosedId = await staff(directStoreId, '대체로종료');
    // 종료 처리 시각: 어제 한국 23:00 — 그 계약 기간의 끝은 어제다(PAY-11 v182)
    await end(
      openEndedClosedId,
      ['SIGNED', 'ENDED'],
      new Date(addDays(today, -1).getTime() + 14 * 3600_000),
    );
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
    const notifications = await prisma.notification.findMany({
      where: { relatedType: 'WORK_SCHEDULE', relatedId: { in: ids } },
      select: { notificationId: true },
    });
    const notificationIds = notifications.map((n) => n.notificationId);
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

  it('종료일이 빈 계약을 대체로 닫으면 종료 처리한 날까지만 받는다(PAY-11 v182)', async () => {
    expect(
      (await post(openEndedClosedId, day(-1), '09:00', '18:00')).status,
    ).toBe(201);
    const res = await post(openEndedClosedId, day(0), '09:00', '18:00');
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

  describe('일괄 등록 POST /work-schedules/bulk (#199)', () => {
    it('규칙에 걸린 줄만 실패로 돌려주고 나머지는 저장하며, 바뀐 직원마다 알림 하나', async () => {
      const res = await asAdmin('post', '/work-schedules/bulk', {
        workDate: day(50),
        rows: [
          {
            staffMemberId: directId,
            startTime: '09:00',
            endTime: '13:00',
            breakMinutes: 0,
          },
          {
            staffMemberId: unjoinedId,
            startTime: '09:00',
            endTime: '13:00',
            breakMinutes: 0,
          },
          {
            staffMemberId: directId,
            startTime: '17:00',
            endTime: '21:00',
            breakMinutes: 0,
          },
          {
            staffMemberId: directId,
            startTime: '12:00',
            endTime: '14:00',
            breakMinutes: 0,
          },
          {
            staffMemberId: direct2Id,
            startTime: '10:00',
            endTime: '15:00',
            breakMinutes: 30,
          },
        ],
      });
      expect(res.status).toBe(201);
      const body = res.body as {
        created: { workScheduleId: number; staffMemberId: number }[];
        failed: { index: number; statusCode: number; code: string | null }[];
      };
      expect(body.created.map((c) => c.staffMemberId)).toEqual([
        directId,
        directId,
        direct2Id,
      ]);
      expect(body.failed).toEqual([
        expect.objectContaining({
          index: 1,
          statusCode: 400,
          code: 'WORK_SCHEDULE_NOT_JOINED',
        }),
        expect.objectContaining({
          index: 3,
          statusCode: 409,
          code: 'WORK_SCHEDULE_OVERLAP',
        }),
      ]);
      const notices = await prisma.notification.findMany({
        where: {
          relatedType: 'WORK_SCHEDULE',
          relatedId: { in: body.created.map((c) => c.workScheduleId) },
        },
        orderBy: { notificationId: 'asc' },
      });
      // 직영하나 2줄 → 알림 하나에 묶음, 직영둘 → 하나
      expect(notices).toHaveLength(2);
      expect(notices[0].body).toMatch(/09:00~13:00 추가, .*17:00~21:00 추가$/);
    });

    it('줄 형식이 틀리면 요청 전체가 400 이고 아무 줄도 저장하지 않는다', async () => {
      const before = await prisma.workSchedule.count({
        where: { staffMemberId: directId },
      });
      const res = await asAdmin('post', '/work-schedules/bulk', {
        workDate: day(51),
        rows: [
          {
            staffMemberId: directId,
            startTime: '09:00',
            endTime: '13:00',
            breakMinutes: 0,
          },
          {
            staffMemberId: directId,
            startTime: '09:15',
            endTime: '13:00',
            breakMinutes: 0,
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(
        await prisma.workSchedule.count({ where: { staffMemberId: directId } }),
      ).toBe(before);
      expect(
        (
          await asAdmin('post', '/work-schedules/bulk', {
            workDate: day(51),
            rows: [],
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('지난 주 복사 /work-schedules/copy-last-week (#200)', () => {
    // 오늘에서 60일 넘게 뒤의 월요일 — 다른 시험이 쓰지 않는 주
    const mondayOffset = (() => {
      for (let i = 60; i < 67; i += 1)
        if (addDays(today, i).getUTCDay() === 1) return i;
      return 60;
    })();
    const weekStart = day(mondayOffset);
    /** 원본 주(월요일 −7)의 그날 한국 hh:mm 을 순간으로 */
    const at = (offset: number, hhmm: string) =>
      new Date(
        addDays(today, mondayOffset - 7 + offset).getTime() -
          9 * 3600_000 +
          (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000,
      );
    type CopyBody = {
      staff: {
        staffMemberId: number | null;
        retiredDate: string | null;
        source: { days: number; minutes: number };
        copied: { days: number; minutes: number };
        excluded: { workDate: string; code: string | null }[];
      }[];
      newcomers: { staffMemberId: number | null }[];
    };

    beforeAll(async () => {
      // 원본은 DB 에 바로 넣는다 — 계약이 끝났거나 퇴직할 직원에게도 지난 주 근무스케줄은 있을 수 있다
      const put = (
        staffMemberId: number,
        offset: number,
        s: string,
        e: string,
        breakMinutes = 0,
      ) =>
        prisma.workSchedule.create({
          data: {
            staffMemberId,
            storeId: directStoreId,
            startAt: at(offset, s),
            endAt: at(offset, e),
            breakMinutes,
            createdBy: bmId,
          },
        });
      await put(directId, 0, '09:00', '13:00');
      await put(directId, 0, '17:00', '21:00');
      await put(directId, 2, '09:00', '18:00', 60);
      await put(endingId, 1, '09:00', '13:00'); // 계약이 오늘+10 에 끝났다 → 제외
      await put(retiringId, 3, '09:00', '13:00'); // 오늘+5 퇴직 → 제외
    });

    it('미리보기는 쓰지 않고 직원별 지난 주 · 복사할 것 · 제외 사유와 지난 주에 없던 직원을 준다', async () => {
      const res = await asAdmin(
        'get',
        `/work-schedules/copy-last-week?storeId=${directStoreId}&weekStart=${weekStart}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as CopyBody;
      const lineOf = (id: number) =>
        body.staff.find((l) => l.staffMemberId === id)!;
      expect(lineOf(directId)).toMatchObject({
        source: { days: 2, minutes: 240 + 240 + 480 },
        copied: { days: 2, minutes: 960 },
        excluded: [],
      });
      expect(lineOf(endingId)).toMatchObject({
        copied: { days: 0, minutes: 0 },
        excluded: [
          {
            workDate: day(mondayOffset + 1),
            code: 'WORK_SCHEDULE_NO_CONTRACT',
          },
        ],
      });
      expect(lineOf(retiringId)).toMatchObject({
        retiredDate: day(5),
        excluded: [
          {
            workDate: day(mondayOffset + 3),
            code: 'WORK_SCHEDULE_AFTER_RETIREMENT',
          },
        ],
      });
      expect(body.newcomers.map((n) => n.staffMemberId)).toContain(direct2Id);
      expect(body.newcomers.map((n) => n.staffMemberId)).not.toContain(
        directId,
      );
      const written = await prisma.workSchedule.count({
        where: {
          storeId: directStoreId,
          startAt: { gte: at(7, '00:00'), lt: at(14, '00:00') },
        },
      });
      expect(written).toBe(0);
    });

    it('복사는 받을 수 있는 것만 넣고, 생긴 직원마다 알림 하나, 두 번째는 빈 주가 아니라 409', async () => {
      const res = await asAdmin('post', '/work-schedules/copy-last-week', {
        storeId: directStoreId,
        weekStart,
      });
      expect(res.status).toBe(201);
      const rows = await prisma.workSchedule.findMany({
        where: {
          storeId: directStoreId,
          isDeleted: false,
          startAt: { gte: at(7, '00:00'), lt: at(14, '00:00') },
        },
        orderBy: { startAt: 'asc' },
      });
      expect(rows.map((r) => r.staffMemberId)).toEqual([
        directId,
        directId,
        directId,
      ]);
      expect(rows[0].startAt).toEqual(at(7, '09:00'));
      expect(rows[2].breakMinutes).toBe(60);
      const notices = await prisma.notification.findMany({
        where: {
          relatedType: 'WORK_SCHEDULE',
          relatedId: { in: rows.map((r) => r.workScheduleId) },
        },
      });
      expect(notices).toHaveLength(1);
      expect(notices[0].body).toMatch(
        /09:00~13:00 추가, .*17:00~21:00 추가, .*09:00~18:00 추가$/,
      );

      const again = await asAdmin('post', '/work-schedules/copy-last-week', {
        storeId: directStoreId,
        weekStart,
      });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        code: 'WORK_SCHEDULE_WEEK_NOT_EMPTY',
      });
      expect(
        (
          await asAdmin(
            'get',
            `/work-schedules/copy-last-week?storeId=${directStoreId}&weekStart=${weekStart}`,
          )
        ).status,
      ).toBe(409);
    });

    it('일요일 밤 근무가 넣을 주 월요일 새벽으로 넘어오면 그 월요일 근무는 겹침으로 뺀다', async () => {
      // 넣을 주보다 두 주 뒤(빈 주)를 쓴다. 원본(at 14~20): 일요일(at 20) 22:00~월요일 06:00, 원본 월요일(at 14) 04:00~08:00
      const week2 = day(mondayOffset + 14);
      await prisma.workSchedule.create({
        data: {
          staffMemberId: direct2Id,
          storeId: directStoreId,
          startAt: at(20, '22:00'),
          endAt: at(21, '06:00'),
          createdBy: bmId,
        },
      });
      await prisma.workSchedule.create({
        data: {
          staffMemberId: direct2Id,
          storeId: directStoreId,
          startAt: at(14, '04:00'),
          endAt: at(14, '08:00'),
          createdBy: bmId,
        },
      });
      const res = await asAdmin(
        'get',
        `/work-schedules/copy-last-week?storeId=${directStoreId}&weekStart=${week2}`,
      );
      expect(res.status).toBe(200);
      const line = (res.body as CopyBody).staff.find(
        (l) => l.staffMemberId === direct2Id,
      )!;
      expect(line.excluded).toEqual([
        { workDate: day(mondayOffset + 14), code: 'WORK_SCHEDULE_OVERLAP' },
      ]);
      expect(line.copied.days).toBe(1); // 일요일 밤은 다음 주 일요일로 복사된다
    });

    it('본사 계정은 원본 주에 가려진 직원이 있는 가맹 점포를 복사하지 못한다(Q9)', async () => {
      await prisma.workSchedule.create({
        data: {
          staffMemberId: unconsentedId,
          storeId: franchiseStoreId,
          startAt: at(1, '09:00'),
          endAt: at(1, '13:00'),
          createdBy: bmId,
        },
      });
      for (const res of [
        await asAdmin(
          'get',
          `/work-schedules/copy-last-week?storeId=${franchiseStoreId}&weekStart=${weekStart}`,
        ),
        await asAdmin('post', '/work-schedules/copy-last-week', {
          storeId: franchiseStoreId,
          weekStart,
        }),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'WORK_SCHEDULE_COPY_HIDDEN_STAFF',
        });
      }
    });

    it('weekStart 가 월요일이 아니면 400, 범위 밖 점포는 404', async () => {
      expect(
        (
          await asAdmin(
            'get',
            `/work-schedules/copy-last-week?storeId=${directStoreId}&weekStart=${day(mondayOffset + 1)}`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await asAdmin(
            'get',
            `/work-schedules/copy-last-week?storeId=2147483647&weekStart=${weekStart}`,
          )
        ).status,
      ).toBe(404);
    });
  });

  describe('저장 알림 (#201)', () => {
    const noticesOf = async (workScheduleId: number) =>
      prisma.notification.findMany({
        where: { relatedType: 'WORK_SCHEDULE', relatedId: workScheduleId },
        include: {
          notificationRecipients: { include: { notificationDeliveries: true } },
        },
        orderBy: { notificationId: 'asc' },
      });

    it('등록 · 수정 · 삭제마다 그 직원에게 알림 하나와 앱 푸시 발송 대기 하나', async () => {
      const { accountId } = await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: direct2Id },
        select: { accountId: true },
      });
      const created = await post(direct2Id, day(40), '09:00', '13:00');
      const id = (created.body as { workScheduleId: number }).workScheduleId;
      await asAdmin('patch', `/work-schedules/${id}`, {
        workDate: day(40),
        startTime: '10:00',
        endTime: '14:00',
        breakMinutes: 0,
      });
      await asAdmin('delete', `/work-schedules/${id}`);

      const notices = await noticesOf(id);
      expect(notices).toHaveLength(3);
      expect(notices.map((n) => n.body)).toEqual([
        expect.stringMatching(/ 09:00~13:00 추가$/),
        expect.stringMatching(/ 09:00~13:00 → 10:00~14:00$/),
        expect.stringMatching(/ 10:00~14:00 삭제$/),
      ]);
      expect(notices[0].title).toBe(
        '근무스케줄 DIRECT 근무스케줄이 바뀌었습니다',
      );
      for (const n of notices) {
        expect(n.notificationTarget).toBe('STAFF');
        expect(n.notificationRecipients).toHaveLength(1);
        expect(n.notificationRecipients[0].accountId).toBe(accountId);
        expect(n.notificationRecipients[0].notificationDeliveries).toEqual([
          expect.objectContaining({ channel: 'PUSH', sentAt: null }),
        ]);
      }
    });

    it('수신 설정 묶음 근무스케줄을 끈 직원은 알림함에만 — 앱 푸시 발송 대기가 없다(NTF-14)', async () => {
      const { accountId } = await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: direct2Id },
        select: { accountId: true },
      });
      await prisma.notificationPreference.create({
        data: {
          accountId: accountId!,
          preferenceCategory: 'SCHEDULE',
          isEnabled: false,
        },
      });
      const created = await post(direct2Id, day(41), '09:00', '13:00');
      const id = (created.body as { workScheduleId: number }).workScheduleId;
      const [notice] = await noticesOf(id);
      expect(notice.notificationRecipients).toHaveLength(1);
      expect(notice.notificationRecipients[0].notificationDeliveries).toEqual(
        [],
      );
    });

    it('시작 · 종료 · 휴게가 모두 같은 수정은 알림을 만들지 않는다(이력은 남는다)', async () => {
      const created = await post(direct2Id, day(43), '09:00', '13:00', 30);
      const id = (created.body as { workScheduleId: number }).workScheduleId;
      const res = await asAdmin('patch', `/work-schedules/${id}`, {
        workDate: day(43),
        startTime: '09:00',
        endTime: '13:00',
        breakMinutes: 30,
      });
      expect(res.status).toBe(200);
      expect(await noticesOf(id)).toHaveLength(1); // 등록 알림만
      expect(
        await prisma.workScheduleHistory.count({
          where: { workScheduleId: id },
        }),
      ).toBe(2);
    });

    it('실패한 저장(겹침 409)은 알림을 남기지 않는다', async () => {
      expect((await post(direct2Id, day(42), '09:00', '13:00')).status).toBe(
        201,
      );
      const before = await prisma.notification.count({
        where: { relatedType: 'WORK_SCHEDULE' },
      });
      expect((await post(direct2Id, day(42), '10:00', '11:00')).status).toBe(
        409,
      );
      expect(
        await prisma.notification.count({
          where: { relatedType: 'WORK_SCHEDULE' },
        }),
      ).toBe(before);
    });
  });

  describe('조회 GET /work-schedules (주간 · 월간)', () => {
    type Roster = {
      staffMemberId: number | null;
      isMasked: boolean;
      schedulableDates: string[];
    };
    type ListBody = {
      staff: Roster[];
      items: {
        workScheduleId: number;
        staffMemberId: number;
        workDate: string;
      }[];
      days: { workDate: string; headcount: number; coverage: number[] }[];
    };

    it('받을 수 있는 직원만 행으로, 날마다 받을 수 있는 날짜와 근무스케줄 · 인원을 준다', async () => {
      // day(30) 하루: 직영하나 09:00-13:00 · 직영둘 12:00-14:00
      expect((await post(directId, day(30), '09:00', '13:00')).status).toBe(
        201,
      );
      expect((await post(direct2Id, day(30), '12:00', '14:00')).status).toBe(
        201,
      );
      const res = await asAdmin(
        'get',
        `/work-schedules?storeId=${directStoreId}&from=${day(29)}&to=${day(31)}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      const ids = body.staff.map((r) => r.staffMemberId);
      // 가입 전 · 날인 전 종료 · 계약 끝 · 퇴직일 뒤 · 대체로 종료는 그 기간에 행이 없다
      expect(ids.sort()).toEqual([directId, direct2Id].sort());
      expect(body.staff[0].schedulableDates).toEqual([
        day(29),
        day(30),
        day(31),
      ]);
      expect(body.items.filter((i) => i.workDate === day(30))).toHaveLength(2);
      const d30 = body.days.find((d) => d.workDate === day(30))!;
      expect(d30.headcount).toBe(2);
      expect(d30.coverage).toHaveLength(48);
      expect(d30.coverage[18]).toBe(1); // 09:00
      expect(d30.coverage[24]).toBe(2); // 12:00
      expect(d30.coverage[27]).toBe(1); // 13:30
      expect(d30.coverage[28]).toBe(0); // 14:00
    });

    it('본사가 가맹 점포를 보면 동의 없는 직원은 행을 두되 비우고, 근무스케줄은 내지 않고 인원에는 센다(ATT-30)', async () => {
      // 본사는 등록하지 못하므로 DB 에 직접 넣는다
      const { contractId } = await prisma.contract.findFirstOrThrow({
        where: { staffMemberId: unconsentedId },
      });
      const startAt = new Date(
        addDays(today, 3).getTime() - 9 * 3600_000 + 10 * 3600_000,
      ); // 10:00 KST
      await prisma.workSchedule.create({
        data: {
          staffMemberId: unconsentedId,
          storeId: franchiseStoreId,
          startAt,
          endAt: new Date(startAt.getTime() + 2 * 3600_000),
          sourceContractId: contractId,
          createdBy: bmId,
        },
      });
      const res = await asAdmin(
        'get',
        `/work-schedules?storeId=${franchiseStoreId}&from=${day(3)}&to=${day(3)}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.staff).toEqual([
        expect.objectContaining({
          staffMemberId: null,
          name: null,
          isMasked: true,
          schedulableDates: [day(3)],
        }),
      ]);
      expect(body.items).toEqual([]);
      expect(body.days[0].headcount).toBe(1);
      expect(body.days[0].coverage[20]).toBe(1); // 10:00
    });

    it('자정을 넘는 근무는 다음 날 새벽 칸에도 세고, 막대 · 인원 수는 시작한 날로(Q4)', async () => {
      expect((await post(directId, day(35), '22:00', '02:00')).status).toBe(
        201,
      );
      const next = (
        await asAdmin(
          'get',
          `/work-schedules?storeId=${directStoreId}&from=${day(36)}&to=${day(36)}`,
        )
      ).body as ListBody;
      expect(next.items).toEqual([]);
      expect(next.days[0].headcount).toBe(0);
      expect(next.days[0].coverage.slice(0, 5)).toEqual([1, 1, 1, 1, 0]);
      const start = (
        await asAdmin(
          'get',
          `/work-schedules?storeId=${directStoreId}&from=${day(35)}&to=${day(35)}`,
        )
      ).body as ListBody;
      expect(start.items).toHaveLength(1);
      expect(start.days[0].headcount).toBe(1);
      expect(start.days[0].coverage[44]).toBe(1);
    });

    it('43일 · 거꾸로 된 기간은 400, 범위 밖 점포는 404', async () => {
      expect(
        (
          await asAdmin(
            'get',
            `/work-schedules?storeId=${directStoreId}&from=${day(0)}&to=${day(42)}`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await asAdmin(
            'get',
            `/work-schedules?storeId=${directStoreId}&from=${day(1)}&to=${day(0)}`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await asAdmin(
            'get',
            `/work-schedules?storeId=2147483647&from=${day(0)}&to=${day(6)}`,
          )
        ).status,
      ).toBe(404);
    });
  });
});
