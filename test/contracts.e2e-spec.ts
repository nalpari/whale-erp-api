import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
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

  const token = (type: UserType) =>
    jwt.sign({ sub: 1, type, email: 'a@b.c', typ: 'access', sid: 1 });
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
      .compile();
    app = fixture.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  beforeEach(() => {
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
      wageAmount: 2400000,
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
        contractMethod: 'ELECTRONIC',
        isTemporarySave: true,
      };
      await post(partial).expect(201);
    });

    it.each<[string, object]>([
      ['초안 저장인데 계약 시작일이 없음', { startDate: undefined }],
      ['임시저장인데 이름이 없음', { isTemporarySave: true, name: undefined }],
      [
        '임시저장인데 근무지가 없음',
        { isTemporarySave: true, storeId: undefined },
      ],
      ['근무 장소가 200자를 넘음', { workLocation: 'x'.repeat(201) }],
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
      ['지급일 32', { payDay: 32 }],
      ['모르는 필드', { memo: 'x' }],
      ['주휴일을 보냄 (서버가 정한다)', { weeklyHoliday: 'SUN' }],
      [
        '근무 요일 안의 모르는 필드',
        { workDays: [{ ...body.workDays[0], note: 'x' }] },
      ],
    ])('%s 이면 400', async (_, over) => {
      await post({ ...body, ...over }).expect(400);
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    });

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
      });
      const res = await put('/contracts/7', draft).expect(200);
      expect(res.body).toEqual({ contractId: 7, staffMemberId: 3 });
    });

    it('임시저장이 아니면 409', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SIGNATURE',
        staffMemberId: 3,
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
      });
      prisma.contract.deleteMany.mockResolvedValue({ count: 1 });
      prisma.contract.count.mockResolvedValue(0);
      await del('/contracts/7').expect(204);
      prisma.contract.findUnique.mockResolvedValue({
        status: 'SIGNED',
        staffMemberId: 3,
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
