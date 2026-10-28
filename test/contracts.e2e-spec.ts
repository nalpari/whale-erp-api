import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminScopeService } from './../src/admin-scope/admin-scope.service';
import { AlimtalkService } from './../src/alimtalk/alimtalk.service';
import { fakeAlimtalk } from './fake-alimtalk';
import { BizppurioError } from './../src/alimtalk/bizppurio.client';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from './../src/admin-session/admin-session.service';
import { AuthSessionService } from './../src/auth-session/auth-session.service';
import { UserType } from './../src/auth/auth.types';
import { PrismaService } from './../src/prisma/prisma.service';
import { STORAGE } from './../src/storage/storage.module';

/**
 * GET /contracts 의 HTTP 계약 — 전역 가드가 실제로 막는지(토큰 없음 401 · 직원 앱 토큰 403),
 * 쿼리 검증(400), 쿼리 문자열이 DTO 로 바뀌어 Prisma 까지 가는 모양. 로그인이 아직 없어 토큰은 여기서 서명한다.
 */
describe('근로계약 목록 (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    // 재입사 사슬 조회(linkedRecords) — 이은 레코드가 없다
    $queryRaw: jest.fn().mockResolvedValue([]),
    // 배열(목록 + 건수)과 함수(이어 쓰기 트랜잭션) 둘 다 받는다. 함수에는 이 목 자신을 tx 로 넘긴다.
    $transaction: jest.fn((arg: unknown): Promise<unknown> =>
      Array.isArray(arg)
        ? Promise.all(arg as Promise<unknown>[])
        : (arg as (tx: unknown) => Promise<unknown>)(prisma),
    ),
    contract: {
      findMany: jest.fn<Promise<unknown[]>, [Prisma.ContractFindManyArgs]>(),
      count: jest.fn<Promise<number>, [Prisma.ContractCountArgs]>(),
      groupBy: jest.fn(),
      findUnique: jest.fn(),
      // 같은 점포 가입 재직 직원의 최근 체결 계약(자동 재계약) — 없다
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    contractParty: { upsert: jest.fn(), deleteMany: jest.fn() },
    contractWorkDay: { deleteMany: jest.fn(), createMany: jest.fn() },
    contractStatusHistory: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
    },
    contractDocument: {
      createMany: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    store: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    invitation: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    notificationTemplate: { findUnique: jest.fn() },
    invitationCodeAttempt: {
      create: jest.fn().mockResolvedValue({ invitationCodeAttemptId: 1 }),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
    account: { findMany: jest.fn() },
    // 메뉴 권한 가드(WHALEERP-592) — 근로계약 관리 권한이 있는 BP 관리자
    adminAccount: { findFirst: jest.fn() },
    roleGroupMenu: { count: jest.fn(), findFirst: jest.fn() },
    menu: { count: jest.fn().mockResolvedValue(1) },
    staffMember: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn<Promise<unknown>, [Prisma.StaffMemberCreateArgs]>(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const storage = {
    put: jest.fn(),
    delete: jest.fn(),
    downloadUrl: jest.fn(),
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

  // 근로계약 발송(WHALEERP-136) — 알림톡은 실제로 보내지 않는다
  const alimtalk = fakeAlimtalk();

  beforeAll(async () => {
    // 가입 초대 알림톡의 직원 앱 설치 링크. 서비스가 만들어질 때 읽는다
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AlimtalkService)
      .useValue(alimtalk)
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
      .overrideProvider(STORAGE)
      .useValue(storage)
      .compile();
    app = fixture.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  beforeEach(() => {
    prisma.adminAccount.findFirst.mockReset().mockResolvedValue({
      roleGroupId: 7,
      roleTypeCode: 'BM',
      bpCodeId: 3,
      bpCode: { isPlatform: false },
    });
    prisma.roleGroupMenu.count.mockReset().mockResolvedValue(1);
    // 가드는 권한 행을 findFirst 로 읽어 메뉴 서비스까지 본다(근로계약은 WHALE_ERP) — 서비스의 다시 묻기
    // (adminHasMenuAction)는 count 다. 한 mock(count)으로 두 판정을 함께 바꾸게 잇는다.
    prisma.roleGroupMenu.findFirst
      .mockReset()
      .mockImplementation(async ({ where }: { where: unknown }) =>
        (await prisma.roleGroupMenu.count({ where })) > 0
          ? { menu: { serviceCode: 'WHALE_ERP' } }
          : null,
      );
    scope.getManageableStores.mockReset().mockResolvedValue({
      roleTypeCode: 'FM',
      stores: [{ storeId: 11, storeTypeCode: 'FRANCHISE' }],
    });
    scope.canManageStaffAt.mockReset().mockResolvedValue(true);
    prisma.contract.findMany.mockReset().mockResolvedValue([]);
    prisma.contract.count.mockReset().mockResolvedValue(0);
    prisma.contract.groupBy.mockReset().mockResolvedValue([]);
    prisma.store.findMany.mockReset().mockResolvedValue([]);
    prisma.store.findFirst.mockReset().mockResolvedValue({ storeId: 11 });
    prisma.staffMember.findFirst.mockReset().mockResolvedValue(null);
    prisma.account.findMany.mockReset().mockResolvedValue([]);
    prisma.staffMember.findMany.mockReset().mockResolvedValue([]);
    prisma.contract.findUnique.mockReset();
    prisma.contract.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prisma.staffMember.update.mockReset();
    storage.put.mockReset().mockResolvedValue(undefined);
    storage.delete.mockReset().mockResolvedValue(undefined);
    prisma.contractDocument.createMany
      .mockReset()
      .mockResolvedValue({ count: 1 });
    prisma.contractDocument.findMany.mockReset().mockResolvedValue([]);
    prisma.staffMember.create
      .mockReset()
      .mockResolvedValue({ staffMemberId: 3, contracts: [{ contractId: 7 }] });
    // 저장하면 곧바로 보낸다(2026-10-19 재영) — 가입 초대 템플릿 · 초대 · 알림톡(실제로 보내지 않음)
    alimtalk.send.mockReset().mockResolvedValue({ referenceKey: 'r' });
    prisma.notificationTemplate.findUnique.mockReset().mockResolvedValue({
      isActive: true,
      channel: 'ALIMTALK',
      title: null,
      body: '…',
      variables: [],
      kakaoTemplateCode: 'WHALE_INVITE_01',
    });
    prisma.store.findUnique
      .mockReset()
      .mockResolvedValue({ name: '모리커피 연남점' });
    prisma.invitation.findMany.mockReset().mockResolvedValue([]);
    prisma.invitation.count.mockReset().mockResolvedValue(0);
    // 커밋 뒤 보내기 직전에 다시 읽는 내 초대 — 그사이 무효가 되지 않았다
    prisma.invitation.findUnique
      .mockReset()
      .mockResolvedValue({ status: 'SENT' });
    prisma.invitation.create
      .mockReset()
      .mockResolvedValue({ invitationId: 50 });
    prisma.contract.update.mockReset();
    prisma.contractStatusHistory.findFirst
      .mockReset()
      .mockResolvedValue({ contractStatusHistoryId: 77 });
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

  // 「근로계약 관리」(/contracts) 메뉴 권한을 가드가 먼저 본다(WHALEERP-592) — 없으면 서비스까지 가지 않는다
  it.each<[string, string, string[]]>([
    ['get', '/contracts/5', ['isReadable']],
    ['get', '/contracts/5/documents/3/download-url', ['isReadable']],
    ['post', '/contracts', ['isCreatable']],
    ['post', '/contracts/paper', ['isCreatable']],
    // 이어 쓰기는 작성 또는 수정으로 받고 서비스가 상태대로 다시 묻는다
    ['put', '/contracts/5', ['isCreatable', 'isUpdatable']],
    ['put', '/contracts/5/paper', ['isCreatable', 'isUpdatable']],
    ['patch', '/contracts/5/worker', ['isUpdatable']],
    ['post', '/contracts/5/send', ['isUpdatable']],
    ['post', '/contracts/5/end', ['isUpdatable']],
    ['delete', '/contracts/5', ['isDeletable']],
  ])(
    '%s %s — 근로계약 관리 권한이 없으면 403, 서비스까지 가지 않는다(WHALEERP-592)',
    async (method, path, columns) => {
      prisma.roleGroupMenu.count.mockResolvedValue(0);
      const req = request(app.getHttpServer());
      const call =
        method === 'get'
          ? req.get(path)
          : method === 'post'
            ? req.post(path)
            : method === 'put'
              ? req.put(path)
              : method === 'patch'
                ? req.patch(path)
                : req.delete(path);
      await call.set('Authorization', `Bearer ${token('admin')}`).expect(403);
      const where = (
        prisma.roleGroupMenu.count.mock.calls[0] as [
          { where: { OR: Record<string, boolean>[] } },
        ]
      )[0].where;
      expect(where.OR).toEqual(columns.map((c) => ({ [c]: true })));
      expect(prisma.contract.findUnique).not.toHaveBeenCalled();
      expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    },
  );

  it('근로계약 관리 조회 권한이 없으면 403 — 목록을 읽지 않는다', async () => {
    prisma.roleGroupMenu.count.mockResolvedValue(0);
    await get('/contracts', 'admin').expect(403);
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
    expect(prisma.roleGroupMenu.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        roleGroupId: 7,
        OR: [{ isReadable: true }],
        menu: expect.objectContaining({ url: '/contracts' }) as unknown,
      }) as unknown,
    });
  });

  it('관리자 토큰이면 { items, total, statusCounts } 를 준다', async () => {
    prisma.contract.count.mockResolvedValue(3);
    prisma.contract.groupBy.mockResolvedValue([
      { status: 'SIGNED', _count: { _all: 3 } },
    ]);
    const res = await get('/contracts', 'admin').expect(200);
    expect(res.body).toEqual({
      items: [],
      total: 3,
      statusCounts: {
        DRAFT: 0,
        PENDING_SEND: 0,
        PENDING_SIGNATURE: 0,
        CORRECTION_REQUESTED: 0,
        SIGNED: 3,
        REJECTED: 0,
        EXPIRED: 0,
        ENDED: 0,
      },
    });
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

  it('고른 점포 · 점포 유형을 쉼표 · 여러 번 모두 받고, 형식이 틀리면 400 (WHALEERP-326)', async () => {
    scope.getManageableStores.mockResolvedValue({
      roleTypeCode: 'PM',
      stores: [
        { storeId: 11, storeTypeCode: 'DIRECT' },
        { storeId: 12, storeTypeCode: 'FRANCHISE' },
        { storeId: 13, storeTypeCode: 'FRANCHISE' },
      ],
    });
    await get('/contracts?storeIds=11,12', 'admin').expect(200);
    await get(
      '/contracts?storeIds=12&storeIds=13&storeTypes=FRANCHISE',
      'admin',
    ).expect(200);
    await get('/contracts?storeTypes=DIRECT', 'admin').expect(200);
    const wheres = prisma.contract.findMany.mock.calls.map(([a]) => a.where);
    expect(wheres).toEqual([
      { storeId: { in: [11, 12] } },
      { storeId: { in: [12, 13] } },
      { storeId: { in: [11] } },
    ]);

    await get('/contracts?storeIds=a', 'admin').expect(400);
    await get('/contracts?storeTypes=HQ', 'admin').expect(400);
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
      staffMember: { account: { isHqSharingConsented: false } },
    });
    scope.canManageStaffAt.mockResolvedValue(false);
    await get('/contracts/7', 'admin').expect(404);
    expect(scope.canManageStaffAt).toHaveBeenCalledWith(1, 12, false);
  });

  // 상태를 바꾸는 경로도 같은 범위 검사를 거친다 — 업무 범위 밖이거나, 본사 역할에게 본사 제공에 동의하지 않은 가맹 점포
  // 직원이면 404 이고 아무것도 바꾸지 않는다(WHALEERP-157, ATT-30)
  it.each<[string, string, object | undefined]>([
    ['post', '/contracts/7/send', undefined],
    ['post', '/contracts/7/end', undefined],
    [
      'patch',
      '/contracts/7/worker',
      {
        name: '남도현',
        phone: '01090145563',
        birthDate: '1998-07-12',
        gender: 'FEMALE',
        isForeigner: false,
      },
    ],
  ])(
    '%s %s — 업무 범위 밖 · 본사 제공 미동의 직원 계약이면 404, 바꾸지 않는다(WHALEERP-157)',
    async (method, path, body) => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 12,
        status: 'PENDING_SEND',
        staffMember: {
          phone: '01090145563',
          account: { isHqSharingConsented: false },
        },
      });
      scope.canManageStaffAt.mockResolvedValue(false);
      const req = request(app.getHttpServer());
      const call = method === 'post' ? req.post(path) : req.patch(path);
      await call
        .set('Authorization', `Bearer ${token('admin')}`)
        .send(body ?? {})
        .expect(404);
      expect(scope.canManageStaffAt).toHaveBeenCalledWith(1, 12, false);
      expect(prisma.contract.updateMany).not.toHaveBeenCalled();
      expect(alimtalk.send).not.toHaveBeenCalled();
    },
  );

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
      gender: 'MALE',
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
      expect(res.body).toEqual({
        contractId: 7,
        staffMemberId: 3,
        status: 'PENDING_SEND',
        draftAction: 'SIGNUP_INVITE',
      });
      const [args] = prisma.staffMember.create.mock.calls[0];
      expect(args.data.contracts).toMatchObject({ create: { createdBy: 1 } });
    });

    it('이름의 앞뒤 공백은 지운다 — 가입 전 레코드를 이름으로 찾는다', async () => {
      await post({ ...body, name: ' 남도현  ' }).expect(201);
      const lookups = prisma.staffMember.findFirst.mock.calls as [
        Prisma.StaffMemberFindFirstArgs,
      ][];
      // 이름으로 찾는 조회 — 가입 전 레코드 재사용과 재입사로 이을 옛 레코드(WHALEERP-615)
      const wheres = JSON.stringify(lookups.map(([a]) => a.where));
      expect(wheres).toContain('"name":"남도현"');
      expect(wheres).not.toContain(' 남도현');
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
        {
          contractId: 5,
          status: 'PENDING_SEND',
          staffMemberId: 2,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
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
      // 본인 대조(WHALEERP-125) — 성별은 초안 저장부터 필수, 외국인 여부는 참 · 거짓
      ['초안 저장인데 성별이 없음', { gender: undefined }],
      ['성별이 남 · 여가 아님', { gender: 'OTHER' }],
      ['외국인 여부가 boolean 이 아님', { isForeigner: 'Y' }],
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

  // 종이 계약 등록(CTR-23) — multipart 한 번으로 내용(data, JSON)과 날인본을 받는다. 저장소는 목이다.
  describe('POST /contracts/paper', () => {
    const data = {
      name: '남도현',
      phone: '01090145563',
      birthDate: '1998-07-12',
      gender: 'MALE',
      storeId: 11,
      jobTitle: '바리스타',
      employmentType: 'PART_TIME',
      contractMethod: 'PAPER',
      startDate: '2026-09-14',
      wageAmount: 12000,
      workDays: [{ weekday: 'MON', startTime: '09:00', endTime: '13:00' }],
      payMonth: 'NEXT_MONTH',
      payDay: 10,
      payMethod: 'CASH',
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: true,
    };
    const PDF = Buffer.from('%PDF-1.7\n날인본');
    const paper = () =>
      request(app.getHttpServer())
        .post('/contracts/paper')
        .set('Authorization', `Bearer ${token('admin')}`);

    it('날인본과 내용을 받아 체결 완료로 만든다 — 파일을 올리고 원래 이름을 남긴다', async () => {
      const res = await paper()
        .field('data', JSON.stringify(data))
        .attach('employmentContract', PDF, '근로계약서 날인본.pdf');
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        contractId: 7,
        staffMemberId: 3,
        status: 'SIGNED',
        draftAction: null,
      });
      const [args] = prisma.staffMember.create.mock.calls[0];
      expect(args.data.contracts).toMatchObject({
        create: { status: 'SIGNED', contractMethod: 'PAPER' },
      });
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect(prisma.contractDocument.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            contractId: 7,
            kind: 'PAPER_EMPLOYMENT_CONTRACT',
            fileName: '근로계약서 날인본.pdf',
          }),
        ],
      });
      // 곧바로 체결 완료라 입사일이 비어 있으면 계약 시작일로(WHALEERP-613)
      expect(prisma.staffMember.updateMany).toHaveBeenCalledWith({
        where: {
          staffMemberId: 3,
          hiredDate: null,
          // 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝나는 근무다
          OR: [
            { retiredDate: null },
            { retiredDate: { gte: new Date('2026-09-14T00:00:00.000Z') } },
          ],
        },
        data: { hiredDate: new Date('2026-09-14T00:00:00.000Z') },
      });
    });

    it('기간이 겹치는 체결 완료 계약이 있으면 대체하지 않고 409 SIGNED_CONTRACT_OVERLAP — 파일을 올리지 않는다(WHALEERP-156)', async () => {
      // 자동 재계약 없음 → 겹치는 체결 완료 있음
      prisma.contract.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ contractId: 5 });
      prisma.contract.findMany.mockResolvedValueOnce([
        {
          contractId: 5,
          status: 'SIGNED',
          staffMemberId: 3,
          startDate: null,
          endDate: null,
          staffMember: { name: '남도현' },
        },
      ]);
      const res = await paper()
        .field('data', JSON.stringify(data))
        .attach('employmentContract', PDF, 'a.pdf')
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'SIGNED_CONTRACT_OVERLAP',
        contracts: [{ contractId: 5, status: 'SIGNED' }],
      });
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    // api #49 3차 리뷰 — 잘못 올린 계약 바로잡기는 체결 완료를 이름 · 종료일로 거르지 않는다. 걸러 두면 아래 두 경우에 같은 사람의
    // 체결 완료가 두 벌 생긴다.
    it.each<[string, object, object]>([
      [
        '(a) 이름 오타를 고쳐 다시 등록',
        { name: '남도연', endDate: null },
        { ...data, name: '남도현', correctSignedContracts: true },
      ],
      [
        '(b) 이미 끝난 계약서를 뒤늦게 등록하며 두 번 누름',
        { name: '남도현', endDate: new Date('2026-10-01T00:00:00Z') },
        {
          ...data,
          startDate: '2026-04-01',
          endDate: '2026-10-01',
          correctSignedContracts: true,
        },
      ],
    ])(
      '%s — 409 에 기존 계약의 이름 · 기간을 싣고 파일은 올리지 않는다',
      async (_, existing, body) => {
        const { name, endDate } = existing as {
          name: string;
          endDate: Date | null;
        };
        prisma.contract.findMany.mockResolvedValueOnce([
          {
            contractId: 5,
            status: 'SIGNED',
            staffMemberId: 3,
            startDate: new Date('2026-04-01T00:00:00Z'),
            endDate,
            staffMember: { name },
          },
        ]);
        // 바로잡을 재계약을 찾을 때 · 대체할 계약을 물을 때 두 번 읽는다
        prisma.contract.findMany.mockResolvedValueOnce([
          {
            contractId: 5,
            status: 'SIGNED',
            staffMemberId: 3,
            startDate: new Date('2026-04-01T00:00:00Z'),
            endDate,
            staffMember: { name },
          },
        ]);
        // 바로잡을 재계약을 찾을 때 · 대체할 계약을 물을 때 두 번 읽는다
        prisma.contract.findMany.mockResolvedValueOnce([
          {
            contractId: 5,
            status: 'SIGNED',
            staffMemberId: 3,
            startDate: new Date('2026-04-01T00:00:00Z'),
            endDate,
            staffMember: { name },
          },
        ]);
        const res = await paper()
          .field('data', JSON.stringify(body))
          .attach('employmentContract', PDF, 'a.pdf')
          .expect(409);
        expect(res.body).toMatchObject({
          code: 'CONTRACT_IN_PROGRESS',
          contracts: [
            {
              contractId: 5,
              status: 'SIGNED',
              name,
              startDate: '2026-04-01',
              endDate: endDate ? '2026-10-01' : null,
            },
          ],
        });
        const [args] = prisma.contract.findMany.mock.calls[0];
        expect(args.where).toEqual({
          storeId: 11,
          status: {
            in: [
              'DRAFT',
              'PENDING_SEND',
              'PENDING_SIGNATURE',
              'CORRECTION_REQUESTED',
              'SIGNED',
            ],
          },
          staffMember: { phone: '01090145563' },
        });
        expect(prisma.staffMember.create).not.toHaveBeenCalled();
        expect(storage.put).not.toHaveBeenCalled();
      },
    );

    it('근로계약서 날인본이 없으면 400', async () => {
      const res = await paper().field('data', JSON.stringify(data));
      expect(res.status).toBe(400);
      expect(prisma.staffMember.create).not.toHaveBeenCalled();
    });

    it.each([
      ['data 가 JSON 이 아님', '{', 'data 칸에'],
      ['data 가 없음', undefined, 'data 칸에'],
    ])('%s 이면 400', async (_, raw, message) => {
      const req = paper();
      if (raw !== undefined) void req.field('data', raw);
      const res = await req.attach('employmentContract', PDF, 'a.pdf');
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(message);
    });

    it('data 칸도 JSON 요청과 같게 검사한다 — 모르는 필드 400', async () => {
      const res = await paper()
        .field('data', JSON.stringify({ ...data, memo: 'x' }))
        .attach('employmentContract', PDF, 'a.pdf');
      expect(res.status).toBe(400);
    });

    it('파일 종류는 내용으로 본다 — 확장자만 pdf 인 글자 파일은 400', async () => {
      const res = await paper()
        .field('data', JSON.stringify(data))
        .attach('employmentContract', Buffer.from('hello'), 'fake.pdf');
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        '파일만 올릴 수 있습니다',
      );
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('JSON 요청(POST /contracts)으로는 종이 계약을 등록하지 못한다 — 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/contracts')
        .set('Authorization', `Bearer ${token('admin')}`)
        .send(data);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        '근로계약서 파일과 함께 등록합니다',
      );
    });

    it('직원 앱 토큰이면 403', async () => {
      await request(app.getHttpServer())
        .post('/contracts/paper')
        .set('Authorization', `Bearer ${token('account')}`)
        .field('data', JSON.stringify(data))
        .attach('employmentContract', PDF, 'a.pdf')
        .expect(403);
    });
  });

  describe('GET /contracts/:contractId/documents/:contractDocumentId/download-url', () => {
    const get = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token('admin')}`);

    beforeEach(() => {
      prisma.contract.findUnique.mockResolvedValue({
        storeId: 11,
        staffMember: { account: { isHqSharingConsented: false } },
      });
      storage.downloadUrl.mockReset().mockResolvedValue('https://signed');
    });

    it('범위 안 계약의 날인본이면 300초 주소를 원래 이름으로 준다', async () => {
      prisma.contractDocument.findFirst.mockResolvedValueOnce({
        storageKey: 'contracts/7/a.pdf',
        fileName: '근로계약서.pdf',
      });
      await get('/contracts/7/documents/3/download-url').expect(200, {
        url: 'https://signed',
      });
      expect(prisma.contractDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            contractDocumentId: 3,
            contractId: 7,
            kind: { not: 'SIGNATURE' },
          },
        }),
      );
      expect(storage.downloadUrl).toHaveBeenCalledWith(
        'contracts/7/a.pdf',
        '근로계약서.pdf',
      );
    });

    it('다른 계약의 파일 ID 면 404', async () => {
      prisma.contractDocument.findFirst.mockResolvedValueOnce(null);
      await get('/contracts/7/documents/99/download-url').expect(404);
    });

    it('업무 범위 밖 계약이면 404 — 주소를 만들지 않는다', async () => {
      scope.canManageStaffAt.mockResolvedValue(false);
      await get('/contracts/7/documents/3/download-url').expect(404);
      expect(storage.downloadUrl).not.toHaveBeenCalled();
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
      expect(res.body).toEqual({
        contractId: 7,
        staffMemberId: 3,
        status: 'DRAFT',
        draftAction: null,
      });
    });

    // api #49 4차 리뷰 — 동의로만 보이는 관리자(본사 역할)가 번호를 바꿔 보내면 그 번호의 같은 점포 계약이
    // 409 에 이름 · 기간과 함께 실리고 대체로 닫을 수도 있었다. 번호 바꾸기는 점포 단위 범위가 있어야 한다.
    it.each([
      ['PUT /contracts/7', '/contracts/7', false],
      ['PUT /contracts/7/paper', '/contracts/7/paper', true],
    ])(
      '%s — 동의로만 보이는 관리자가 번호를 바꾸면 403, 같은 점포 계약을 묻지 않는다',
      async (_, path, paper) => {
        prisma.contract.findUnique.mockResolvedValue({
          status: 'DRAFT',
          staffMemberId: 3,
          storeId: 11,
          staffMember: {
            phone: draft.phone,
            account: { isHqSharingConsented: true },
          },
        });
        scope.canManageStaffAt.mockImplementation(
          (_: number, __: number, consented: boolean) =>
            Promise.resolve(consented),
        );
        const other = { ...draft, phone: '01011112222' };
        const req = request(app.getHttpServer())
          .put(path)
          .set('Authorization', `Bearer ${token('admin')}`);
        const res = paper
          ? await req
              .field(
                'data',
                JSON.stringify({
                  ...other,
                  isTemporarySave: undefined,
                  contractMethod: 'PAPER',
                  birthDate: '1998-07-12',
                  gender: 'MALE',
                  startDate: '2026-09-14',
                  wageAmount: 12000,
                  workDays: [
                    { weekday: 'MON', startTime: '09:00', endTime: '13:00' },
                  ],
                  payMonth: 'NEXT_MONTH',
                  payDay: 10,
                  payMethod: 'CASH',
                  isHealthPensionInsured: false,
                  isEmploymentInjuryInsured: true,
                }),
              )
              .attach('employmentContract', Buffer.from('%PDF-1.7\n'), 'a.pdf')
          : await req.send(other);
        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toContain(
          '점포 직원 관리 권한',
        );
        expect(prisma.contract.findMany).not.toHaveBeenCalled();
        expect(prisma.contract.updateMany).not.toHaveBeenCalled();
        expect(storage.put).not.toHaveBeenCalled();
      },
    );

    // api #49 5차 리뷰 참고 1 — 번호를 그대로 둬도, 같은 점포 · 같은 번호의 다른 직원 레코드 계약은 동의로만 보는 관리자에게 403
    it('동의로만 보이는 관리자가 번호 그대로 저장해도 다른 직원 레코드 계약이 걸리면 403 — 이름을 보이지 않는다', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        status: 'DRAFT',
        staffMemberId: 3,
        storeId: 11,
        staffMember: {
          phone: draft.phone,
          account: { isHqSharingConsented: true },
        },
      });
      prisma.contract.findMany.mockResolvedValueOnce([
        {
          contractId: 5,
          status: 'PENDING_SEND',
          staffMemberId: 8,
          startDate: null,
          endDate: null,
          staffMember: { name: '다른사람' },
        },
      ]);
      scope.canManageStaffAt.mockImplementation(
        (_: number, __: number, consented: boolean) =>
          Promise.resolve(consented),
      );
      const res = await put('/contracts/7', {
        ...draft,
        replaceContractIds: [5],
      }).expect(403);
      expect(JSON.stringify(res.body)).not.toContain('다른사람');
      expect(prisma.contract.updateMany).not.toHaveBeenCalled();
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
        staffMember: { account: { isHqSharingConsented: false } },
      });
      prisma.contract.deleteMany.mockResolvedValue({ count: 1 });
      prisma.contract.count.mockResolvedValue(0);
      await del('/contracts/7').expect(204);
      prisma.contract.findUnique.mockResolvedValue({
        status: 'SIGNED',
        staffMemberId: 3,
        staffMember: { account: { isHqSharingConsented: false } },
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
  // 날인 전 근로자 정보 수정(WHALEERP-125 · 126, 2026-10-16)
  describe('PATCH /contracts/:contractId/worker', () => {
    const worker = {
      name: '남도현',
      phone: '01090145563',
      birthDate: '1998-07-12',
      gender: 'FEMALE',
      isForeigner: true,
    };
    const patch = (payload: object, type: UserType = 'admin') =>
      request(app.getHttpServer())
        .patch('/contracts/7/worker')
        .set('Authorization', `Bearer ${token(type)}`)
        .send(payload);

    beforeEach(() => {
      // 다른 describe 가 남긴 호출을 비운다(이 목은 위 beforeEach 가 초기화하지 않는다)
      prisma.contractParty.upsert.mockClear();
      // 가입 초대가 나간 발송 대기(링크를 받지 못했다는 직원)
      prisma.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        storeId: 11,
        staffMemberId: 3,
        startDate: new Date('2026-11-01T00:00:00Z'),
        endDate: null,
        draftAction: 'SIGNUP_INVITE',
        sentAt: new Date('2026-10-10T01:00:00Z'),
        signDeadlineAt: new Date('2026-11-09T01:00:00Z'),
        staffMember: {
          phone: '01090145563',
          joinStatus: 'INVITED',
          candidateAccountId: null,
          account: { isHqSharingConsented: false },
        },
        contractWorkDays: [],
      });
    });

    it('발송 대기면 고치고 곧바로 가입 초대를 새로 보낸다 — 200 과 id', async () => {
      const res = await patch(worker).expect(200);
      expect(res.body).toEqual({
        contractId: 7,
        staffMemberId: 3,
        status: 'PENDING_SEND',
        draftAction: 'SIGNUP_INVITE',
      });
      expect(prisma.contract.updateMany).not.toHaveBeenCalled();
      expect(prisma.invitation.create).toHaveBeenCalled();
      expect(alimtalk.send).toHaveBeenCalled();
      expect(prisma.contractParty.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            enteredGender: 'FEMALE',
            isForeigner: true,
          }) as object,
        }),
      );
    });

    it.each<[string, object]>([
      ['성별이 없음', { gender: undefined }],
      ['생년월일이 없음', { birthDate: undefined }],
      ['번호 모양이 아님', { phone: '010-1234' }],
      ['모르는 칸', { jobTitle: '바리스타' }],
    ])('%s 이면 400', async (_, over) => {
      await patch({ ...worker, ...over }).expect(400);
      expect(prisma.contractParty.upsert).not.toHaveBeenCalled();
    });

    it('체결 완료면 409 CONTRACT_STATUS_CONFLICT', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        status: 'SIGNED',
        storeId: 11,
        staffMemberId: 3,
        startDate: null,
        endDate: null,
        staffMember: {
          phone: '01090145563',
          joinStatus: 'DRAFT',
          account: { isHqSharingConsented: false },
        },
        contractWorkDays: [],
      });
      const res = await patch(worker).expect(409);
      expect(res.body).toMatchObject({ code: 'CONTRACT_STATUS_CONFLICT' });
    });

    it('직원 앱 토큰이면 403', async () => {
      await patch(worker, 'account').expect(403);
    });

    // 이메일은 회원 ID 라 근로자 정보 수정으로도 고치지 못한다(WHALEERP-180) — 실으면 400, 아무것도 쓰지 않는다
    it('email 을 실으면 400 이고 아무것도 쓰지 않는다', async () => {
      prisma.staffMember.update.mockClear();
      const res = await patch({
        ...worker,
        email: 'changed@test.invalid',
      }).expect(400);
      expect((res.body as { message: string[] }).message).toContain(
        'property email should not exist',
      );
      expect(prisma.contractParty.upsert).not.toHaveBeenCalled();
      expect(prisma.staffMember.update).not.toHaveBeenCalled();
      await patch(worker).expect(200);
    });
  });

  // 이메일은 회원 ID 라 관리자 요청으로는 고치지 못한다(WHALEERP-180, ACC-17). 근로계약은 직원 레코드를 쓰는 요청이지만
  // email 칸이 없다 — JSON 이든 multipart 의 data 칸이든 실으면 무시하지 않고 400 이고, 직원 · 계약 당사자 · 파일
  // 어느 것도 쓰지 않는다. 경로마다 email 만 빼면 통과하는 본문으로 확인해, 400 이 다른 칸 때문이 아님을 함께 본다.
  describe('직원 이메일(회원 ID)은 근로계약 요청으로 고칠 수 없다', () => {
    const staff = {
      name: '남도현',
      phone: '01090145563',
      birthDate: '1998-07-12',
      gender: 'MALE',
      storeId: 11,
      jobTitle: '바리스타',
      employmentType: 'PART_TIME',
      startDate: '2026-09-14',
      wageAmount: 12000,
      workDays: [{ weekday: 'MON', startTime: '09:00', endTime: '13:00' }],
      payMonth: 'NEXT_MONTH',
      payDay: 10,
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: true,
    };
    const electronic = {
      ...staff,
      contractMethod: 'ELECTRONIC',
      payMethod: 'ACCOUNT',
    };
    const paperData = { ...staff, contractMethod: 'PAPER', payMethod: 'CASH' };
    const email = { email: 'changed@test.invalid' };
    const PDF = Buffer.from('%PDF-1.7\n날인본');

    const send = (
      method: 'post' | 'put',
      path: string,
      payload: object,
      multipart: boolean,
    ) => {
      const req = request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${token('admin')}`);
      return multipart
        ? req
            .field('data', JSON.stringify(payload))
            .attach('employmentContract', PDF, 'a.pdf')
        : req.send(payload);
    };

    beforeEach(() => {
      // 앞 테스트의 호출 기록이 「아무것도 쓰지 않는다」를 흐리지 않게 기록만 비운다(돌려줄 값은 둔다).
      jest.clearAllMocks();
      // 이어 쓰기가 고칠 임시저장 계약. email 이 없으면 200 으로 저장되는 상태다.
      prisma.contract.findUnique.mockResolvedValue({
        status: 'DRAFT',
        staffMemberId: 3,
        storeId: 11,
        staffMember: {
          phone: staff.phone,
          account: { isHqSharingConsented: false },
        },
      });
    });

    it.each([
      ['POST /contracts', 'post', '/contracts', electronic, false, 201],
      ['PUT /contracts/7', 'put', '/contracts/7', electronic, false, 200],
      [
        'POST /contracts/paper',
        'post',
        '/contracts/paper',
        paperData,
        true,
        201,
      ],
      [
        'PUT /contracts/7/paper',
        'put',
        '/contracts/7/paper',
        paperData,
        true,
        200,
      ],
    ] as const)(
      '%s 에 email 을 실으면 400 이고 아무것도 쓰지 않는다',
      async (_, method, path, payload, multipart, ok) => {
        const res = await send(
          method,
          path,
          { ...payload, ...email },
          multipart,
        );

        expect(res.status).toBe(400);
        expect((res.body as { message: string[] }).message).toContain(
          'property email should not exist',
        );
        expect(prisma.staffMember.create).not.toHaveBeenCalled();
        expect(prisma.staffMember.update).not.toHaveBeenCalled();
        expect(prisma.contractParty.upsert).not.toHaveBeenCalled();
        expect(storage.put).not.toHaveBeenCalled();
        await send(method, path, payload, multipart).expect(ok);
      },
    );
  });

  // 근로계약 발송 · 재발송(WHALEERP-136, 2026-10-16) — 가입 초대 알림톡
  describe('저장하면 곧바로 보낸다 (2026-10-19 재영)', () => {
    const body = {
      name: '남도현',
      phone: '01090145563',
      birthDate: '1998-07-12',
      gender: 'MALE',
      storeId: 11,
      jobTitle: '바리스타',
      employmentType: 'PART_TIME',
      contractMethod: 'ELECTRONIC',
      startDate: '2026-11-01',
      wageAmount: 12000,
      workDays: [{ weekday: 'MON', startTime: '09:00', endTime: '13:00' }],
      payMonth: 'NEXT_MONTH',
      payDay: 10,
      payMethod: 'ACCOUNT',
      isHealthPensionInsured: false,
      isEmploymentInjuryInsured: true,
    };
    const post = (payload: object) =>
      request(app.getHttpServer())
        .post('/contracts')
        .set('Authorization', `Bearer ${token('admin')}`)
        .send(payload);

    it('계정이 없는 번호면 발송 대기로 만들고 커밋 뒤 가입 초대 알림톡을 보낸다 — 201', async () => {
      await post(body).expect(201);
      const [created] = prisma.staffMember.create.mock.calls[0];
      expect(created.data).toMatchObject({
        contracts: { create: { status: 'PENDING_SEND' } },
      });
      expect(prisma.invitation.create).toHaveBeenCalled();
      expect(alimtalk.send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: 'TALK_STAFF_INVITATION',
          to: '01090145563',
          related: { type: 'contract', id: 7 },
        }),
      );
    });

    it('계정이 있는 번호면 서명 대기로 만들고 알림톡은 보내지 않는다(앱 알림은 아직 없음)', async () => {
      prisma.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      await post(body).expect(201);
      const [created] = prisma.staffMember.create.mock.calls[0];
      expect(created.data).toMatchObject({
        contracts: { create: { status: 'PENDING_SIGNATURE' } },
      });
      expect(prisma.invitation.create).not.toHaveBeenCalled();
      expect(alimtalk.send).not.toHaveBeenCalled();
    });

    it('알림톡이 거절되면 임시저장으로 되돌리고 502 SEND_FAILED 와 계약 ID', async () => {
      alimtalk.send.mockRejectedValue(new BizppurioError('거절', 4100, 400));
      prisma.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        sentAt: null,
      });
      prisma.invitation.findUnique.mockResolvedValue({ status: 'SENT' });
      const res = await post(body).expect(502);
      expect(res.body).toMatchObject({
        code: 'SEND_FAILED',
        contractId: 7,
      });
    });

    it('임시저장은 보내지 않는다', async () => {
      await post({ ...body, isTemporarySave: true }).expect(201);
      expect(prisma.invitation.create).not.toHaveBeenCalled();
      expect(alimtalk.send).not.toHaveBeenCalled();
    });
  });

  describe('POST /contracts/:contractId/send', () => {
    const send = (path = '/contracts/7/send', type: UserType = 'admin') =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token(type)}`);

    beforeEach(() => {
      prisma.contract.findUnique.mockResolvedValue({
        status: 'PENDING_SEND',
        storeId: 11,
        sentAt: null,
        signDeadlineAt: null,
        draftAction: 'SIGNUP_INVITE',
        staffMemberId: 3,
        staffMember: {
          phone: '01090145563',
          joinStatus: 'INVITED',
          candidateAccountId: null,
          account: { isHqSharingConsented: false },
        },
      });
    });

    it('발송 대기면 상태 그대로 가입 초대 알림톡을 새로 보낸다(재발송) — 200', async () => {
      const res = await send().expect(200);
      expect(res.body).toMatchObject({
        contractId: 7,
        status: 'PENDING_SEND',
      });
      // 상태는 그대로 — 전환하지 않는다
      expect(prisma.contract.updateMany).not.toHaveBeenCalled();
      expect(prisma.invitation.create).toHaveBeenCalled();
      expect(alimtalk.send).toHaveBeenCalledWith(
        expect.objectContaining({
          templateCode: 'TALK_STAFF_INVITATION',
          to: '01090145563',
        }),
      );
      const [sent] = alimtalk.send.mock.calls[0] as [
        { variables: Record<string, string> },
      ];
      // 초대 코드(대문자 · 숫자 8자리)는 본문 변수, 링크는 직원 앱 origin 의 /invite#token=…
      expect(sent.variables.초대코드).toMatch(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/,
      );
      expect(sent.variables.링크).toMatch(
        /^https:\/\/staff\.e2e\.test\/invite#token=[A-Za-z0-9_-]{43}$/,
      );
    });

    it('계정이 있는 직원이면 409 SEND_CHANNEL_NOT_READY', async () => {
      prisma.account.findMany.mockResolvedValue([{ accountId: 42 }]);
      const res = await send().expect(409);
      expect(res.body).toMatchObject({ code: 'SEND_CHANNEL_NOT_READY' });
      expect(alimtalk.send).not.toHaveBeenCalled();
    });

    it('본문 expectedStatus 가 지금 상태와 다르면 409 CONTRACT_STATUS_CONFLICT, 모르는 값이면 400(front #136 재리뷰)', async () => {
      const res = await send()
        .send({ expectedStatus: 'PENDING_SIGNATURE' })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'CONTRACT_STATUS_CONFLICT',
        status: 'PENDING_SEND',
      });
      await send().send({ expectedStatus: 'NOPE' }).expect(400);
      // 시간대 없는 발송 시각은 서버 시간대에 따라 다른 순간이라 받지 않는다(api #158 셀프 code-review)
      await send().send({ expectedSentAt: '2026-10-10T10:00:00' }).expect(400);
      expect(alimtalk.send).not.toHaveBeenCalled();
    });

    it('경로 id 가 틀리면 DB 전에 404, 직원 앱 토큰이면 403', async () => {
      await send('/contracts/abc/send').expect(404);
      await send('/contracts/7/send', 'account').expect(403);
      expect(alimtalk.send).not.toHaveBeenCalled();
    });
  });
});
