import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from './../src/admin-session/admin-session.service';
import { AuthSessionService } from './../src/auth-session/auth-session.service';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from './../src/auth/access-messages';
import { UserType } from './../src/auth/auth.types';
import { ExcelExportsService } from './../src/excel-exports/excel-exports.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { StoreManagementService } from './../src/stores/store-management.service';

/** 점포 정보 관리 — 경로 순서 · 입력 검증 · 상태 코드. 업무 규칙은 StoreManagementService 단위 테스트가 본다. */
describe('점포 정보 관리 (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const management = {
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    detail: jest.fn().mockResolvedValue({ storeId: 11 }),
    histories: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    transitionCheck: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ storeId: 50, storeCode: 'ST000050' }),
    update: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    verifyBusiness: jest.fn().mockResolvedValue({ result: 'VERIFIED' }),
    putImage: jest.fn(),
    removeImage: jest.fn().mockResolvedValue(undefined),
  };
  /** 1분 제한 · 1만 건 · 이력은 공통 엑셀 e2e(excel-exports.e2e-spec)가 실제 DB 로 본다. 여기서는 경로 · 조건만. */
  const excelExports = {
    request: jest.fn().mockResolvedValue({
      kind: 'file',
      fileName: '점포목록_20261014.xlsx',
      buffer: Buffer.from('PK'),
    }),
  };
  /**
   * 점포의 모든 경로는 MenuPermissionGuard 가 PrismaService 로 직접 메뉴 권한을 판정한다(대표 이미지 올리기에서는
   * 인터셉터보다 먼저 돈다). 사용 중인 관리자이고 그 권한 그룹에 필요한 권한이 있는 것으로 둔다 — 거절 사례는
   * 테스트에서 바꾼다.
   */
  // 점포는 WHALE_ERP 메뉴라 가드가 대상 BP 도 정한다 — 헤더 없이 부르므로 소속 BP 다.
  const ADMIN = {
    roleGroupId: 2,
    roleTypeCode: 'BM',
    bpCodeId: 1,
    bpCode: { isPlatform: false },
  };
  /** 헤더 없이 부른 ADMIN 에게 가드가 정해 서비스에 넘기는 대상 BP(@TargetBp) */
  const OWN_BP = { bpCodeId: 1, isPlatformCaller: false };
  const ALLOWED = { menu: { serviceCode: 'WHALE_ERP' } };
  const prisma = {
    adminAccount: {
      findFirst: jest.fn().mockResolvedValue(ADMIN),
    },
    roleGroupMenu: { findFirst: jest.fn().mockResolvedValue(ALLOWED) },
    // 거절할 때 가드가 판정할 메뉴가 있는지 한 번 더 본다(없으면 로그) — 메뉴는 있는 것으로 둔다.
    menu: { count: jest.fn().mockResolvedValue(1) },
  };
  const send = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    type?: UserType,
  ) => {
    const req = request(app.getHttpServer())[method](path);
    if (!type) return req;
    const token = jwt.sign({
      sub: 1,
      type,
      ...(type === 'admin' ? { loginId: 'admin' } : { email: 'a@b.c' }),
      typ: 'access',
      sid: 1,
    });
    return req.set('Authorization', `Bearer ${token}`);
  };
  const validUpdate = {
    name: '서초점',
    storeStatus: 'NOT_OPERATING',
    updatedAt: '2026-10-14T01:00:00.000Z',
  };
  const identity = (bizRegistrationNumber: string, openDate: string) => ({
    bizRegistrationNumber,
    ceoName: '김대표',
    openDate,
  });

  beforeAll(async () => {
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AuthSessionService)
      .useValue({ isActive: jest.fn().mockResolvedValue(true) })
      .overrideProvider(AdminSessionService)
      .useValue({
        findActive: jest
          .fn()
          .mockResolvedValue({ isPasswordChangeRequired: false }),
      })
      .overrideProvider(StoreManagementService)
      .useValue(management)
      .overrideProvider(ExcelExportsService)
      .useValue(excelExports)
      .compile();
    app = fixture.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.adminAccount.findFirst.mockResolvedValue(ADMIN);
    prisma.roleGroupMenu.findFirst.mockResolvedValue(ALLOWED);
  });

  it('토큰이 없으면 401, 직원 앱 토큰이면 403', async () => {
    await send('get', '/stores').expect(401);
    await send('get', '/stores', 'account').expect(403);
  });

  it('목록은 쉼표 · 하이픈을 풀어 서비스에 넘긴다', async () => {
    await send(
      'get',
      '/stores?statuses=OPERATING,CLOSED&storeIds=3,4&bizRegistrationNumber=123-45&pageSize=50',
      'admin',
    ).expect(200);
    expect(management.list).toHaveBeenCalledWith(
      expect.anything(),
      OWN_BP,
      expect.objectContaining({
        statuses: ['OPERATING', 'CLOSED'],
        storeIds: [3, 4],
        bizRegistrationNumber: '12345',
        page: 1,
        pageSize: 50,
      }),
    );
  });

  it.each([
    'pageSize=30',
    'statuses=OPEN',
    'storeTypes=HQ',
    'storeIds=0',
    // NUL 은 PostgreSQL 이 text 로 받지 않아 그대로 보내면 500 이다.
    'keyword=%00',
    `storeIds=${Array.from({ length: 1001 }, (_, i) => i + 1).join(',')}`,
    // BP 는 X-Bp-Code-Id 헤더로만 받는다 — 뺀 쿼리 칸은 전역 파이프(forbidNonWhitelisted)가 400 으로 막는다.
    'bpCodeId=3',
  ])('목록 쿼리 %s 는 400', async (query) => {
    await send('get', `/stores?${query}`, 'admin').expect(400);
    expect(management.list).not.toHaveBeenCalled();
  });

  it('business-verifications 는 :id 로 잡히지 않고, 번호의 하이픈을 뺀다', async () => {
    await send('post', '/stores/business-verifications', 'admin')
      .send(identity('123-45-67890', '2020-03-02'))
      .expect(200, { result: 'VERIFIED' });
    expect(management.verifyBusiness).toHaveBeenCalledWith(
      expect.anything(),
      OWN_BP,
      expect.objectContaining({ bizRegistrationNumber: '1234567890' }),
    );
  });

  it('경로 id 가 integer 범위 밖이면 404', async () => {
    await send('get', '/stores/2147483648', 'admin').expect(404);
    expect(management.detail).not.toHaveBeenCalled();
  });

  it('등록은 201 이고 빠진 선택 칸은 기본값, 점포 유형이 없으면 400', async () => {
    await send('post', '/stores', 'admin')
      .send({ storeTypeCode: 'DIRECT', name: '서초점' })
      .expect(201, { storeId: 50, storeCode: 'ST000050' });
    expect(management.create).toHaveBeenCalledWith(
      expect.anything(),
      OWN_BP,
      expect.objectContaining({
        isLocationApplied: true,
        floors: [],
        business: {},
      }),
    );
    await send('post', '/stores', 'admin').send({ name: '서초점' }).expect(400);
  });

  it('수정은 204', async () => {
    await send('put', '/stores/11', 'admin').send(validUpdate).expect(204);
    expect(management.update).toHaveBeenCalledWith(
      expect.anything(),
      OWN_BP,
      11,
      expect.objectContaining({ name: '서초점' }),
    );
  });

  // 가드가 정한 대상 BP 가 실제 요청에서 서비스까지 가는가 — 비플랫폼 계정은 서비스가 bp 를 읽지 않아 빠져도 티가 안 난다.
  it.each([
    ['histories', '/stores/11/histories'],
    ['transitionCheck', '/stores/11/transition-check'],
  ] as const)(
    '%s 는 가드의 대상 BP 를 서비스에 넘긴다',
    async (method, path) => {
      await send('get', path, 'admin').expect(200);
      const [, bp, storeId] = management[method].mock.calls[0] as unknown[];
      expect(bp).toEqual(OWN_BP);
      expect(storeId).toBe(11);
    },
  );

  it.each([
    ['위도 범위', { latitude: 91 }],
    ['위도 소수 7자리', { latitude: 37.1234567 }],
    ['연락처 형식', { phone: '02-123-4567' }],
    ['오프셋 없는 updatedAt', { updatedAt: '2026-10-14T01:00:00' }],
    ['층 좌석수 음수', { floors: [{ seatCount: -1 }] }],
    // null 은 기본값을 덮어써 서비스에서 500 이 됐다 — 빼고 보내면 기본값, null 은 400.
    ['층별 정보 null', { floors: null }],
    ['층 한 줄이 null', { floors: [null] }],
    ['위치 적용 여부 null', { isLocationApplied: null }],
    ['사업자정보 null', { business: null }],
    ['업태 51자', { business: { category: 'a'.repeat(51) } }],
    [
      '사업자번호 9자리',
      { businessVerification: identity('123456789', '2020-03-02') },
    ],
    [
      '없는 개업일자',
      { businessVerification: identity('1234567890', '2020-02-30') },
    ],
  ])('수정 몸통의 %s 는 400', async (_, patch) => {
    await send('put', '/stores/11', 'admin')
      .send({ ...validUpdate, ...patch })
      .expect(400);
    expect(management.update).not.toHaveBeenCalled();
  });

  it('엑셀은 :id 로 잡히지 않고 xlsx 로 내려오며, 검색 조건을 풀어 넘긴다', async () => {
    const res = await send(
      'get',
      '/stores/excel?statuses=OPERATING,CLOSED&bizRegistrationNumber=123-45',
      'admin',
    )
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename\*=UTF-8''/,
    );
    expect((res.body as Buffer).toString()).toBe('PK');
    expect(management.detail).not.toHaveBeenCalled();
    expect(excelExports.request).toHaveBeenCalledWith(
      expect.objectContaining({ menuUrl: '/stores' }),
      { adminAccountId: 1, bp: OWN_BP },
      expect.objectContaining({
        statuses: ['OPERATING', 'CLOSED'],
        bizRegistrationNumber: '12345',
      }),
    );
  });

  it('1만 건 이상이면 202 와 안내 JSON 이다 — 파일은 메일 링크로 간다', async () => {
    excelExports.request.mockResolvedValueOnce({
      kind: 'scheduled',
      excelDownloadId: 41,
      rowCount: 12_480,
    });
    const res = await send('get', '/stores/excel', 'admin').expect(202);
    expect(res.body).toMatchObject({ excelDownloadId: 41, rowCount: 12_480 });
  });

  // 쪽 칸과 뺀 bpCodeId 는 엑셀 쿼리에 없다 — 전역 파이프가 400 으로 막는다(목록 쿼리를 그대로 넘기면 안 된다).
  it.each(['page=1', 'bpCodeId=3'])('엑셀 쿼리 %s 는 400', async (query) => {
    await send('get', `/stores/excel?${query}`, 'admin').expect(400);
    expect(excelExports.request).not.toHaveBeenCalled();
  });

  describe('대표 이미지', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    it('multipart 의 file 하나를 한글 이름 그대로 서비스에 넘기고 200', async () => {
      management.putImage.mockResolvedValue({ fileId: 70 });
      await send('put', '/stores/11/image', 'admin')
        .attach('file', PNG, '서초점.png')
        .expect(200, { fileId: 70 });
      expect(management.putImage).toHaveBeenCalledWith(
        expect.anything(),
        OWN_BP,
        11,
        expect.objectContaining({ originalname: '서초점.png', size: 8 }),
      );
    });

    it('파일이 둘이면 서비스에 닿기 전에 400', async () => {
      await send('put', '/stores/11/image', 'admin')
        .attach('file', PNG, 'a.png')
        .attach('file', PNG, 'b.png')
        .expect(400);
      expect(management.putImage).not.toHaveBeenCalled();
    });

    it('5MB 를 넘으면 서비스에 닿기 전에 400', async () => {
      const res = await send('put', '/stores/11/image', 'admin')
        .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.png')
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        '파일은 5MB까지 올릴 수 있습니다.',
      );
      expect(management.putImage).not.toHaveBeenCalled();
    });

    // 인터셉터가 먼저 돌면 파일 2개는 400 이다. 403 이면 가드가 multipart 를 읽기 전에 막았다는 뜻이다.
    // (5MB 넘는 본문으로 재면 서버가 먼저 답하고 연결을 끊어 클라이언트가 ECONNRESET 을 받는다 — 결정적이지 않다.)
    it('수정 권한이 없으면 multipart 를 받기 전에 가드가 403 — 인터셉터라면 400 일 파일 2개도 403', async () => {
      prisma.roleGroupMenu.findFirst.mockResolvedValue(null);
      const res = await send('put', '/stores/11/image', 'admin')
        .attach('file', PNG, 'a.png')
        .attach('file', PNG, 'b.png')
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        ACCESS_DENIED_MESSAGE,
      );
      const [[countArgs]] = prisma.roleGroupMenu.findFirst.mock.calls as [
        [{ where: object }],
      ];
      expect(countArgs.where).toMatchObject({
        roleGroupId: 2,
        OR: [{ isUpdatable: true }],
        // 하위 경로(:id/image)도 컨트롤러 경로의 첫 단계로 메뉴(점포 정보 관리 /stores)를 찾는다.
        menu: { url: '/stores' },
      });
      expect(management.putImage).not.toHaveBeenCalled();
    });

    it('사용 중인 관리자 계정이 아니면 가드가 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      const res = await send('put', '/stores/11/image', 'admin')
        .attach('file', PNG, 'a.png')
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        ACCOUNT_UNAVAILABLE_MESSAGE,
      );
      expect(prisma.roleGroupMenu.findFirst).not.toHaveBeenCalled();
      expect(management.putImage).not.toHaveBeenCalled();
    });

    it('직원 앱 토큰이면 403', async () => {
      await send('put', '/stores/11/image', 'account')
        .attach('file', PNG, 'a.png')
        .expect(403);
      expect(prisma.adminAccount.findFirst).not.toHaveBeenCalled();
      expect(management.putImage).not.toHaveBeenCalled();
    });

    it('지우기는 204', async () => {
      await send('delete', '/stores/11/image', 'admin').expect(204);
      expect(management.removeImage).toHaveBeenCalledWith(
        expect.anything(),
        OWN_BP,
        11,
      );
      expect(management.remove).not.toHaveBeenCalled();
    });
  });

  it('삭제는 204', async () => {
    await send('delete', '/stores/11', 'admin').expect(204);
    expect(management.remove).toHaveBeenCalledWith(
      expect.anything(),
      OWN_BP,
      11,
    );
  });
});
