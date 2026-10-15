import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminScopeService } from './../src/admin-scope/admin-scope.service';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from './../src/admin-session/admin-session.service';
import { AuthSessionService } from './../src/auth-session/auth-session.service';
import { UserType } from './../src/auth/auth.types';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * GET /contracts 의 HTTP 계약 — 전역 가드가 실제로 막는지(토큰 없음 401 · 직원 앱 토큰 403),
 * 쿼리 검증(400), 쿼리 문자열이 DTO 로 바뀌어 Prisma 까지 가는 모양. 로그인이 아직 없어 토큰은 여기서 서명한다.
 */
describe('근로계약 목록 (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    // 배열(목록 + 건수)과 함수(이어 쓰기 트랜잭션) 둘 다 받는다. 함수에는 이 목 자신을 tx 로 넘긴다.
    $transaction: jest.fn((arg: unknown): Promise<unknown> =>
      Array.isArray(arg)
        ? Promise.all(arg as Promise<unknown>[])
        : (arg as (tx: unknown) => Promise<unknown>)(prisma),
    ),
    contract: {
      findMany: jest.fn<Promise<unknown[]>, [Prisma.ContractFindManyArgs]>(),
      count: jest.fn<Promise<number>, [Prisma.ContractCountArgs]>(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    contractParty: { upsert: jest.fn(), deleteMany: jest.fn() },
    contractWorkDay: { deleteMany: jest.fn(), createMany: jest.fn() },
    contractStatusHistory: { create: jest.fn(), deleteMany: jest.fn() },
    store: { findMany: jest.fn(), findFirst: jest.fn() },
    account: { findMany: jest.fn() },
    staffMember: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn<Promise<unknown>, [Prisma.StaffMemberCreateArgs]>(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const scope = {
    getManageableStores: jest.fn(),
    canManageStaffAt: jest.fn(),
  };

  const token = (type: UserType) =>
    jwt.sign({
      sub: 1,
      type,
      email: 'a@b.c',
      loginId: 'admin',
      typ: 'access',
      sid: 1,
    });
  const get = (path: string, type?: UserType) => {
    const req = request(app.getHttpServer()).get(path);
    return type ? req.set('Authorization', `Bearer ${token(type)}`) : req;
  };

  beforeAll(async () => {
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      // 직원 앱 토큰은 접속 상태(sid)가 살아 있어야 가드를 지나 종류 검사(403)에 닿는다.
      .overrideProvider(AuthSessionService)
      .useValue({ isActive: jest.fn().mockResolvedValue(true) })
      .overrideProvider(AdminSessionService)
      .useValue({
        findActive: jest
          .fn()
          .mockResolvedValue({ isPasswordChangeRequired: false }),
      })
      // 업무 범위는 AdminScopeService 단위 테스트가 본다. 여기서는 점포 11 을 관리하는 가맹 관리자다.
      .overrideProvider(AdminScopeService)
      .useValue(scope)
      .compile();
    app = fixture.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  beforeEach(() => {
    scope.getManageableStores.mockReset().mockResolvedValue({
      roleTypeCode: 'FM',
      stores: [{ storeId: 11, storeTypeCode: 'FRANCHISE' }],
    });
    scope.canManageStaffAt.mockReset().mockResolvedValue(true);
    prisma.contract.findMany.mockReset().mockResolvedValue([]);
    prisma.contract.count.mockReset().mockResolvedValue(0);
    prisma.store.findMany.mockReset().mockResolvedValue([]);
    prisma.store.findFirst.mockReset().mockResolvedValue({ storeId: 11 });
    prisma.staffMember.findFirst.mockReset().mockResolvedValue(null);
    prisma.account.findMany.mockReset().mockResolvedValue([]);
    prisma.staffMember.findMany.mockReset().mockResolvedValue([]);
    prisma.contract.findUnique.mockReset();
    prisma.contract.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prisma.staffMember.update.mockReset();
    prisma.staffMember.create
      .mockReset()
      .mockResolvedValue({ staffMemberId: 3, contracts: [{ contractId: 7 }] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('토큰이 없으면 401', async () => {
    await get('/contracts').expect(401);
  });

  it('직원 앱 토큰이면 403', async () => {
    await get('/contracts', 'account').expect(403);
  });

  it('관리자 토큰이면 { items, total } 을 준다', async () => {
    prisma.contract.count.mockResolvedValue(3);
    const res = await get('/contracts', 'admin').expect(200);
    expect(res.body).toEqual({ items: [], total: 3 });
  });

  it('쿼리 문자열을 숫자 · 배열로 바꿔 넘긴다 (기본값 page 1 · pageSize 20)', async () => {
    await get('/contracts?status=SIGNED', 'admin').expect(200);
    let [args] = prisma.contract.findMany.mock.calls[0];
    expect(args).toMatchObject({
      skip: 0,
      take: 20,
      where: { status: { in: ['SIGNED'] } },
    });

    await get(
      '/contracts?page=2&pageSize=50&status=SIGNED&status=REJECTED',
      'admin',
    ).expect(200);
    [args] = prisma.contract.findMany.mock.calls[1];
    expect(args).toMatchObject({
      skip: 50,
      take: 50,
      where: { status: { in: ['SIGNED', 'REJECTED'] } },
    });
  });

  it('사용 중인 관리자 계정이 아니면 403', async () => {
    scope.getManageableStores.mockResolvedValue(null);
    await get('/contracts', 'admin').expect(403);
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  it('업무 범위 안 점포의 계약만 읽는다', async () => {
    await get('/contracts', 'admin').expect(200);
    expect(scope.getManageableStores).toHaveBeenCalledWith(1);
    const [args] = prisma.contract.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ storeId: { in: [11] } });
  });

  it('업무 범위 밖 계약은 404', async () => {
    prisma.contract.findUnique.mockResolvedValue({
      storeId: 12,
      staffMember: { isHqSharingConsented: false },
    });
    scope.canManageStaffAt.mockResolvedValue(false);
    await get('/contracts/7', 'admin').expect(404);
    expect(scope.canManageStaffAt).toHaveBeenCalledWith(1, 12, false);
  });

  it.each([
    ['pageSize 가 200 을 넘으면', '/contracts?pageSize=201'],
    ['page 가 0 이면', '/contracts?page=0'],
    ['없는 상태 값이면', '/contracts?status=DONE'],
    ['모르는 쿼리면', '/contracts?sort=name'],
  ])('%s 400', async (_, path) => {
    await get(path, 'admin').expect(400);
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  describe('POST /contracts', () => {
    const body = {
      name: '남도현',
      phone: '01090145563',
      birthDate: '1998-07-12',
      storeId: 11,
      jobTitle: '바리스타',
      employmentType: 'FULL_TIME',
      contractMethod: 'ELECTRONIC',
      startDate: '2026-09-14',
      wageAmount: 12000,
      workDays: [
        {
          weekday: 'MON',
          startTime: '09:00',
          endTime: '18:00',
          breakStartTime: '12:00',
          breakEndTime: '13:00',
        },
      ],
      payMonth: 'NEXT_MONTH',
      payDay: 10,
      payMethod: 'ACCOUNT',
      isHealthPensionInsured: true,
      isEmploymentInjuryInsured: false,
    };
    const post = (payload: object, type: UserType = 'admin') =>
      request(app.getHttpServer())
        .post('/contracts')
        .set('Authorization', `Bearer ${token(type)}`)
        .send(payload);

    it('관리자면 201 과 만든 id 를 준다. 작성 관리자는 토큰의 sub 다', async () => {
      const res = await post(body).expect(201);
      expect(res.body).toEqual({ contractId: 7, staffMemberId: 3 });
      const [args] = prisma.staffMember.create.mock.calls[0];
      expect(args.data.contracts).toMatchObject({ create: { createdBy: 1 } });
    });

    it('이름의 앞뒤 공백은 지운다 — 가입 전 레코드를 이름으로 찾는다', async () => {
      await post({ ...body, name: ' 남도현  ' }).expect(201);
      const lookups = prisma.staffMember.findFirst.mock.calls as [
        Prisma.StaffMemberFindFirstArgs,
      ][];
      expect(lookups.at(-1)?.[0].where).toMatchObject({ name: '남도현' });
      const [args] = prisma.staffMember.create.mock.calls[0];
      expect(args.data).toMatchObject({ name: '남도현' });
    });

    it('이름이 공백뿐이면 400', async () => {
      await post({ ...body, name: '   ' }).expect(400);
    });

    it('isTemporarySave 면 임시저장(DRAFT)으로 만든다', async () => {
      await post({ ...body, isTemporarySave: true }).expect(201);
      const [args] = prisma.staffMember.create.mock.calls[0];
      expect(args.data.contracts).toMatchObject({
        create: { status: 'DRAFT' },
      });
    });

    it('임시저장은 직원 칸과 근무지만으로 201', async () => {
      const partial = {
        name: '남도현',
        phone: '01090145563',
        storeId: 11,
        jobTitle: '바리스타',
        employmentType: 'PART_TIME',
        isTemporarySave: true,
      };
      // 계약 방식도 임시저장이면 비워 둘 수 있다
      await post(partial).expect(201);
    });

    it('api #12 칸(수당 · 월 근로시간 · 조항)을 받아 계약에 넣는다', async () => {
      await post({
        ...body,
        mealAllowanceAmount: 200000,
        baseHours: 209,
        baseNightHours: 12.5,
        annualLeaveTerms: '근로기준법 제50조에 의거하여 연차휴가를 제공함',
      }).expect(201);
      const [args] = prisma.staffMember.create.mock.calls[0];
      expect(args.data.contracts).toMatchObject({
        create: {
          mealAllowanceAmount: 200000,
          baseHours: 209,
          baseNightHours: 12.5,
          annualLeaveTerms: '근로기준법 제50조에 의거하여 연차휴가를 제공함',
          severancePayTerms: null,
        },
      });
    });

    it('같은 점포에 진행 중 계약이 있으면 409 와 그 목록(code CONTRACT_IN_PROGRESS)', async () => {
      prisma.contract.findMany.mockResolvedValueOnce([
        { contractId: 5, status: 'PENDING_SEND', staffMemberId: 2 },
      ]);
      const res = await post(body).expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'CONTRACT_IN_PROGRESS',
        contracts: [{ contractId: 5, status: 'PENDING_SEND' }],
      });
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    });

    it.each<[string, object]>([
      ['초안 저장인데 계약 시작일이 없음', { startDate: undefined }],
      ['임시저장인데 이름이 없음', { isTemporarySave: true, name: undefined }],
      [
        '임시저장인데 근무지가 없음',
        { isTemporarySave: true, storeId: undefined },
      ],
      ['근무 장소가 200자를 넘음', { workLocation: 'x'.repeat(201) }],
      ['초안 저장인데 계약 방식이 없음', { contractMethod: undefined }],
    ])('%s 이면 400', async (_, over) => {
      await post({ ...body, ...over }).expect(400);
    });

    it('isTemporarySave 가 boolean 이 아니면 400', async () => {
      await post({ ...body, isTemporarySave: 'yes' }).expect(400);
    });

    it('직원 앱 토큰이면 403', async () => {
      await post(body, 'account').expect(403);
    });

    it.each<[string, object]>([
      ['휴대전화번호에 하이픈', { phone: '010-9014-5563' }],
      [
        '30분 단위가 아닌 시각',
        { workDays: [{ ...body.workDays[0], startTime: '09:15' }] },
      ],
      ['근무 요일이 없음', { workDays: [] }],
      ['종이 계약', { contractMethod: 'PAPER' }],
      ['없는 날짜', { startDate: '2026-02-30' }],
      // ISO 8601 의 다른 모양 — 받으면 만 19세 계산이 NaN 이 되어 500 이었다
      ['주 단위 날짜', { birthDate: '2026-W01' }],
      ['연도만 있는 날짜', { startDate: '2026' }],
      // integer 컬럼을 넘는 값 — DB 로 가면 500 이었다
      ['시급이 integer 를 넘음', { wageAmount: 3_000_000_000 }],
      ['근무지 id 가 integer 를 넘음', { storeId: 3_000_000_000 }],
      ['수당이 음수', { carAllowanceAmount: -1 }],
      ['근로시간이 30분 단위가 아님', { baseHours: 1.3 }],
      ['근로시간이 numeric(5,1) 을 넘음', { monthlyOvertimeHours: 10000 }],
      ['조항이 1000자를 넘음', { severancePayTerms: 'x'.repeat(1001) }],
      ['대체할 계약 id 가 숫자가 아님', { replaceContractIds: ['a'] }],
      ['지급일 32', { payDay: 32 }],
      ['모르는 필드', { memo: 'x' }],
      // 주휴일 · 급여 지급 방식 · 수습 (노무사 확인 2026-10-14, 데모 확인 2026-10-15)
      ['주 15시간 미만인데 주휴일을 보냄', { weeklyHoliday: 'SUN' }],
      ['모르는 주휴일', { weeklyHoliday: 'HOLIDAY' }],
      ['급여 지급 방식이 없음', { payMethod: undefined }],
      ['모르는 급여 지급 방식', { payMethod: 'CHECK' }],
      ['수습 4개월', { probationMonths: 4, probationWageReductionRate: 10 }],
      [
        '수습 감액률 11%',
        { probationMonths: 3, probationWageReductionRate: 11 },
      ],
      ['수습 기간만 보냄', { probationMonths: 3 }],
      [
        '파트타이머 수습',
        {
          employmentType: 'PART_TIME',
          probationMonths: 3,
          probationWageReductionRate: 10,
        },
      ],
      [
        '1년 미만 계약의 수습',
        {
          endDate: '2027-03-13',
          probationMonths: 3,
          probationWageReductionRate: 10,
        },
      ],
      [
        '근무 요일 안의 모르는 필드',
        { workDays: [{ ...body.workDays[0], note: 'x' }] },
      ],
    ])('%s 이면 400', async (_, over) => {
      await post({ ...body, ...over }).expect(400);
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    });

    // 월~금 하루 8시간 — 주 40시간이라 주휴일이 있어야 한다
    const fullWeek = (['MON', 'TUE', 'WED', 'THU', 'FRI'] as const).map(
      (weekday) => ({
        ...body.workDays[0],
        weekday,
      }),
    );

    it('주 15시간 이상이면 고른 주휴일 · 급여 지급 방식 · 수습을 저장한다', async () => {
      await post({
        ...body,
        workDays: fullWeek,
        weeklyHoliday: 'SAT',
        payMethod: 'CASH',
        probationMonths: 3,
        probationWageReductionRate: 10,
      }).expect(201);
      const [args] = prisma.staffMember.create.mock.calls[0];
      expect(args.data.contracts).toMatchObject({
        create: {
          weeklyHoliday: 'SAT',
          payMethod: 'CASH',
          probationMonths: 3,
          probationWageReductionRate: 10,
        },
      });
    });

    it.each([
      ['주휴일을 고르지 않음', {}, '주휴일을 골라야'],
      [
        '근무하는 요일을 주휴일로 고름',
        { weeklyHoliday: 'MON' },
        '근무하지 않는 요일',
      ],
    ])(
      '주 15시간 이상인데 %s 이면 400 과 그 사유',
      async (_, over, message) => {
        const res = await post({ ...body, workDays: fullWeek, ...over }).expect(
          400,
        );
        expect((res.body as { message: string }).message).toContain(message);
      },
    );

    it('만 19세 미만이면 400 과 그 사유', async () => {
      const res = await post({ ...body, birthDate: '2008-01-01' }).expect(400);
      expect((res.body as { message: string }).message).toContain(
        '만 19세 미만',
      );
    });
  });

  describe('GET · PUT /contracts/:contractId (임시저장 이어 쓰기)', () => {
    const draft = {
      name: '남도현',
      phone: '01090145563',
      storeId: 11,
      jobTitle: '바리스타',
      employmentType: 'PART_TIME',
      contractMethod: 'ELECTRONIC',
      isTemporarySave: true,
    };
    const put = (path: string, payload: object) =>
      request(app.getHttpServer())
        .put(path)
        .set('Authorization', `Bearer ${token('admin')}`)
        .send(payload);

    it.each(['/contracts/abc', '/contracts/0', '/contracts/2147483648'])(
      'GET %s 는 DB 에 가기 전에 404',
      async (path) => {
        await get(path, 'admin').expect(404);
        expect(prisma.contract.findUnique).not.toHaveBeenCalled();
      },
    );

    it('없는 계약이면 404', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);
      await get('/contracts/7', 'admin').expect(404);
    });

    it('직원 앱 토큰이면 PUT 도 403', async () => {
      await request(app.getHttpServer())
        .put('/contracts/7')
        .set('Authorization', `Bearer ${token('account')}`)
        .send(draft)
        .expect(403);
    });

    it('임시저장을 고치면 200 과 id', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        status: 'DRAFT',
        staffMemberId: 3,
        staffMember: { phone: draft.phone },
      });
      const res = await put('/contracts/7', draft).expect(200);
      expect(res.body).toEqual({ contractId: 7, staffMemberId: 3 });
    });

    it('임시저장이 아니면 409', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SIGNATURE',
        staffMemberId: 3,
        staffMember: { phone: draft.phone },
      });
      await put('/contracts/7', draft).expect(409);
      expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    });

    it('DELETE 는 임시저장이면 204, 아니면 409, 경로 id 가 틀리면 DB 전에 404', async () => {
      const del = (path: string) =>
        request(app.getHttpServer())
          .delete(path)
          .set('Authorization', `Bearer ${token('admin')}`);
      prisma.contract.findUnique.mockResolvedValue({
        status: 'DRAFT',
        staffMemberId: 3,
        staffMember: { isHqSharingConsented: false },
      });
      prisma.contract.deleteMany.mockResolvedValue({ count: 1 });
      prisma.contract.count.mockResolvedValue(0);
      await del('/contracts/7').expect(204);
      prisma.contract.findUnique.mockResolvedValue({
        status: 'SIGNED',
        staffMemberId: 3,
        staffMember: { isHqSharingConsented: false },
      });
      await del('/contracts/7').expect(409);
      await del('/contracts/abc').expect(404);
    });

    it('본문 검사는 저장과 같다 — 초안 저장으로 넘기며 시작일이 없으면 400', async () => {
      await put('/contracts/7', { ...draft, isTemporarySave: false }).expect(
        400,
      );
    });
  });
});
