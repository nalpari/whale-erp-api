import { randomInt } from 'node:crypto';
import ExcelJS from 'exceljs';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';
import { StorageService } from '../src/storage/storage.service';
import { STORE_BUSINESS_VERIFIER } from '../src/stores/store-business-verifier';
import type {
  CreateStoreResponseDto,
  StoreDetailResponseDto,
  StoreListResponseDto,
} from '../src/stores/dto/store.response.dto';

const PASSWORD = 'Whale-admin-1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
// 실제 PostgreSQL 에서만 도는 동시성 검사. PGlite 는 세션이 하나라 연결이 서로 잠금을 기다리지 않는다.
const onRealPostgres = process.env.E2E_REAL_POSTGRES === '1' ? it : it.skip;

/**
 * 점포 정보 관리를 실제 DB 로 — 관계 필터 · 채번 · 낙관적 잠금 왕복 · 409 롤백 · 부분 고유 인덱스.
 * 저장소(S3)는 메모리 가짜로, 국세청 진위확인은 늘 맞다고 답하는 가짜로 바꾼다.
 */
describe('점포 정보 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let bpCodeId: number;
  const adminIds: number[] = [];
  let bmToken: string;
  let baToken: string;
  const objects = new Map<string, Buffer>();
  const storage = {
    put: jest.fn((key: string, body: Buffer) => {
      objects.set(key, body);
      return Promise.resolve();
    }),
    delete: jest.fn((key: string) => {
      objects.delete(key);
      return Promise.resolve();
    }),
    downloadUrl: jest.fn((key: string) =>
      Promise.resolve(`https://signed.test/${key}`),
    ),
  };
  // 사업자번호는 테스트마다 새로 만든다 — 같은 DB 에서 다시 돌려도 겹치지 않게.
  const nextBizNumber = () => String(randomInt(1_000_000_000, 9_999_999_999));

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    token = bmToken,
  ) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);

  const create = async (name: string, token = bmToken) => {
    const res = await call('post', '/stores', token)
      .send({ storeTypeCode: 'DIRECT', name })
      .expect(201);
    return res.body as CreateStoreResponseDto;
  };
  const detail = async (storeId: number) =>
    (await call('get', `/stores/${storeId}`).expect(200))
      .body as StoreDetailResponseDto;
  /** 상세를 그대로 돌려보내는 수정 몸통 */
  const formOf = (d: StoreDetailResponseDto) => ({
    name: d.name,
    storeStatus: d.storeStatusCode,
    updatedAt: d.updatedAt,
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(STORAGE)
      .useValue(storage)
      .overrideProvider(STORE_BUSINESS_VERIFIER)
      .useValue({ verify: () => Promise.resolve(true) })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        tradeName: '점포 관리 DB 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    const passwordHash = await hashPassword(PASSWORD);
    const loginAs = async (roleTypeCode: string, isAllStores: boolean) => {
      const { roleGroupId } = await prisma.roleGroup.findFirstOrThrow({
        where: { roleCode: 'BM000001' },
      });
      const admin = await prisma.adminAccount.create({
        data: {
          loginId: `str${randomInt(10_000_000, 99_999_999)}`,
          bpCodeId,
          name: '홍길동',
          passwordHash,
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(admin.adminAccountId);
      const res = await request(app.getHttpServer())
        .post('/auth/admin/login')
        .send({ loginId: admin.loginId, password: PASSWORD })
        .expect(200);
      return (res.body as AdminLoginResponseDto).accessToken;
    };
    bmToken = await loginAs('BM', true);
    // 일부 점포만 맡은 BP 관리자 — 같은 권한 그룹이라 메뉴 권한은 같고 범위만 다르다.
    baToken = await loginAs('BA', false);
  });

  afterAll(async () => {
    // bpCodeId 가 없으면(준비 실패) 아무것도 지우지 않는다 — Prisma 는 where 의 undefined 를 조건 없음으로 읽어
    // DB 의 모든 점포 · BP 를 지운다.
    if (prisma && bpCodeId !== undefined) {
      const stores = await prisma.store.findMany({
        where: { bpCodeId },
        select: { storeId: true },
      });
      const byStore = { storeId: { in: stores.map((s) => s.storeId) } };
      const byAdmin = { adminAccountId: { in: adminIds } };
      // 계약 테스트가 중간에 깨져 남긴 계약 · 직원도 지운다 — 남으면 점포 삭제가 외래키에 막힌다.
      await prisma.contract.deleteMany({ where: byStore });
      await prisma.staffMember.deleteMany({ where: byStore });
      await prisma.storeImageFile.deleteMany({ where: byStore });
      await prisma.storeFloor.deleteMany({ where: byStore });
      await prisma.storeBusinessProfile.deleteMany({ where: byStore });
      await prisma.storeChangeHistory.deleteMany({ where: byStore });
      await prisma.adminStoreMapping.deleteMany({ where: byStore });
      await prisma.store.deleteMany({ where: byStore });
      await prisma.adminLoginLog.deleteMany({ where: byAdmin });
      await prisma.adminSession.deleteMany({ where: byAdmin });
      await prisma.adminAccount.deleteMany({ where: byAdmin });
      await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    }
    await app?.close();
  });

  it('점포코드는 지운 점포를 포함한 마지막 코드 다음이다 — 지운 코드를 다시 쓰지 않는다', async () => {
    const first = await create('채번 1');
    await call('delete', `/stores/${first.storeId}`).expect(204);
    const second = await create('채번 2');
    expect(Number(second.storeCode.slice(2))).toBeGreaterThan(
      Number(first.storeCode.slice(2)),
    );
    expect(second.storeCode).toMatch(/^ST\d{6}$/);
  });

  // 409 는 쓰기 전에 나므로 이 테스트는 롤백이 아니라 updatedAt 왕복을 증명한다(롤백은 단위 테스트가 본다).
  it('상세의 updatedAt 을 그대로 돌려보내면 저장되고, 같은 값으로 다시 보내면 409 이고 아무것도 바뀌지 않는다', async () => {
    const { storeId } = await create('낙관적 잠금');
    const before = await detail(storeId);
    await call('put', `/stores/${storeId}`)
      .send({ ...formOf(before), name: '낙관적 잠금 1' })
      .expect(204);

    const floorsBefore = await prisma.storeFloor.count({ where: { storeId } });
    const historiesBefore = await prisma.storeChangeHistory.count({
      where: { storeId },
    });
    // 옛 updatedAt — 층 · 사업자정보 · 이력을 함께 바꾸려 해도 하나도 남지 않아야 한다.
    await call('put', `/stores/${storeId}`)
      .send({
        ...formOf(before),
        name: '낙관적 잠금 2',
        floors: [{ floorTypeCode: 'GROUND', floorNumber: 1 }],
        business: { tradeName: '모리' },
      })
      .expect(409);
    expect(await prisma.storeFloor.count({ where: { storeId } })).toBe(
      floorsBefore,
    );
    expect(await prisma.storeChangeHistory.count({ where: { storeId } })).toBe(
      historiesBefore,
    );
    expect(
      await prisma.storeBusinessProfile.count({ where: { storeId } }),
    ).toBe(0);
    expect((await detail(storeId)).name).toBe('낙관적 잠금 1');
  });

  it('사업자등록번호는 미운영 · 운영 점포끼리만 고유하다 — 폐점하면 다른 점포가 쓸 수 있다', async () => {
    const number = nextBizNumber();
    const identity = {
      bizRegistrationNumber: number,
      ceoName: '김대표',
      openDate: '2020-03-02',
    };
    const a = await create('번호 A');
    await call('put', `/stores/${a.storeId}`)
      .send({
        ...formOf(await detail(a.storeId)),
        businessVerification: identity,
      })
      .expect(204);

    await call('post', '/stores')
      .send({
        storeTypeCode: 'DIRECT',
        name: '번호 B',
        businessVerification: identity,
      })
      .expect(409);
    await call('post', '/stores/business-verifications')
      .send(identity)
      .expect(200, { result: 'DUPLICATE' });

    await call('put', `/stores/${a.storeId}`)
      .send({ ...formOf(await detail(a.storeId)), storeStatus: 'CLOSED' })
      .expect(204);
    const b = await call('post', '/stores')
      .send({
        storeTypeCode: 'DIRECT',
        name: '번호 B',
        businessVerification: identity,
      })
      .expect(201);

    // 목록의 사업자번호 검색은 관계 필터로, 하이픈 · 일부만 넣어도 찾는다.
    const hyphenated = `${number.slice(0, 3)}-${number.slice(3, 5)}`;
    const list = (
      await call(
        'get',
        `/stores?bizRegistrationNumber=${hyphenated}&statuses=NOT_OPERATING,CLOSED`,
      ).expect(200)
    ).body as StoreListResponseDto;
    expect(list.items.map((i) => i.storeId).sort()).toEqual(
      [a.storeId, (b.body as CreateStoreResponseDto).storeId].sort(),
    );
  });

  it('인증과 좌표가 있으면 운영으로 바꾸고, 폐점일은 한국 날짜로 남는다', async () => {
    const { storeId } = await create('운영 전환');
    await call('put', `/stores/${storeId}`)
      .send({
        ...formOf(await detail(storeId)),
        storeStatus: 'OPERATING',
        latitude: 37.491234,
        longitude: 127.012345,
        businessVerification: {
          bizRegistrationNumber: nextBizNumber(),
          ceoName: '김대표',
          openDate: '2020-03-02',
        },
      })
      .expect(204);
    const operating = await detail(storeId);
    expect(operating).toMatchObject({
      storeStatusCode: 'OPERATING',
      latitude: 37.491234,
      longitude: 127.012345,
      business: { isVerified: true },
    });

    await call('put', `/stores/${storeId}`)
      .send({
        ...formOf(operating),
        storeStatus: 'CLOSED',
        latitude: 37.491234,
        longitude: 127.012345,
      })
      .expect(204);
    const kstToday = new Date(Date.now() + 9 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    expect((await detail(storeId)).closedDate).toBe(kstToday);
  });

  // 폐점 · 삭제 규칙이 보는 근로계약 건수를 실제 행으로 확인한다. 계약 · 직원은 afterAll 이 점포와 함께 지운다.
  it('진행 중인 근로계약이 있는 점포는 폐점 · 삭제가 409 이고 상태는 그대로다', async () => {
    const { storeId } = await create('계약 있는 점포');
    const staff = await prisma.staffMember.create({
      data: {
        storeId,
        name: '김직원',
        phone: `010${randomInt(10_000_000, 99_999_999)}`,
        jobTitle: '홀',
        employmentType: 'PART_TIME',
        joinStatus: 'DRAFT',
      },
    });
    await prisma.contract.create({
      data: {
        staffMemberId: staff.staffMemberId,
        storeId,
        status: 'DRAFT',
        contractMethod: 'ELECTRONIC',
        createdBy: adminIds[0],
      },
    });
    await call('delete', `/stores/${storeId}`).expect(409);
    await call('put', `/stores/${storeId}`)
      .send({ ...formOf(await detail(storeId)), storeStatus: 'CLOSED' })
      .expect(409);
    expect((await detail(storeId)).storeStatusCode).toBe('NOT_OPERATING');
  });

  it('대표 이미지를 바꾸면 살아 있는 행은 늘 하나다(부분 고유 인덱스) — 지우면 없다', async () => {
    const { storeId } = await create('이미지');
    const put = (name: string) =>
      call('put', `/stores/${storeId}/image`)
        .attach('file', PNG, name)
        .expect(200);
    await put('첫 사진.png');
    await put('둘째 사진.png');
    const live = await prisma.storeImageFile.findMany({
      where: { storeId, isDeleted: false },
    });
    expect(live.map((i) => i.fileName)).toEqual(['둘째 사진.png']);
    expect((await detail(storeId)).image).toMatchObject({
      fileName: '둘째 사진.png',
      fileType: 'PNG',
      url: expect.stringContaining(`stores/${storeId}/`) as string,
    });

    await call('delete', `/stores/${storeId}/image`).expect(204);
    expect(
      await prisma.storeImageFile.count({
        where: { storeId, isDeleted: false },
      }),
    ).toBe(0);
    expect(await prisma.storeImageFile.count({ where: { storeId } })).toBe(2);
    const fields = (
      await prisma.storeChangeHistory.findMany({
        where: { storeId, field: '대표 이미지' },
        orderBy: { changeId: 'asc' },
      })
    ).map((h) => [h.beforeValue, h.afterValue]);
    expect(fields).toEqual([
      [null, '첫 사진.png'],
      ['첫 사진.png', '둘째 사진.png'],
      ['둘째 사진.png', null],
    ]);
  });

  it('일부 점포만 맡은 관리자는 자기가 등록한 점포만 본다 — 매핑이 실제로 걸린다', async () => {
    const mine = await create('BA 의 점포', baToken);
    const others = await create('BM 의 점포');
    const list = (
      await call('get', '/stores?pageSize=100', baToken).expect(200)
    ).body as StoreListResponseDto;
    const ids = list.items.map((i) => i.storeId);
    expect(ids).toContain(mine.storeId);
    expect(ids).not.toContain(others.storeId);
    await call('get', `/stores/${others.storeId}`, baToken).expect(404);
  });

  it('엑셀은 목록과 같은 조건으로 실제 행을 담는다', async () => {
    await create('엑셀 점포');
    await create('다른 점포');
    const res = await call(
      'get',
      `/stores/excel?keyword=${encodeURI('엑셀 점포')}`,
    )
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as ArrayBuffer);
    const names: unknown[] = [];
    workbook.worksheets[0].eachRow((row, i) => {
      if (i > 1) names.push(row.getCell(2).value);
    });
    expect(names).toEqual(['엑셀 점포']);
  });

  // ── 아래는 연결 두 개가 필요하다. 실제 PostgreSQL 일회용 DB 에서 E2E_REAL_POSTGRES=1 로 돌린다. ──

  onRealPostgres(
    '동시에 등록해도 점포코드가 겹치지 않는다(채번 잠금)',
    async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => create(`동시 등록 ${i}`)),
      );
      const codes = results.map((r) => r.storeCode);
      expect(new Set(codes).size).toBe(codes.length);
    },
  );

  onRealPostgres(
    '같은 사업자번호를 동시에 등록하면 하나만 된다(번호 잠금 뒤 다시 세기)',
    async () => {
      const identity = {
        bizRegistrationNumber: nextBizNumber(),
        ceoName: '김대표',
        openDate: '2020-03-02',
      };
      const statuses = await Promise.all(
        [1, 2].map(
          async (i) =>
            (
              await call('post', '/stores').send({
                storeTypeCode: 'DIRECT',
                name: `동시 번호 ${i}`,
                businessVerification: identity,
              })
            ).status,
        ),
      );
      expect(statuses.sort()).toEqual([201, 409]);
    },
  );

  onRealPostgres(
    '같은 점포의 이미지를 동시에 바꿔도 500 없이 살아 있는 행은 하나다',
    async () => {
      const { storeId } = await create('동시 이미지');
      const statuses = await Promise.all(
        [1, 2, 3].map(
          async (i) =>
            (
              await call('put', `/stores/${storeId}/image`).attach(
                'file',
                PNG,
                `${i}.png`,
              )
            ).status,
        ),
      );
      expect(statuses).toEqual([200, 200, 200]);
      expect(
        await prisma.storeImageFile.count({
          where: { storeId, isDeleted: false },
        }),
      ).toBe(1);
    },
  );
});

// StorageService 를 가짜로 바꿨으니 키 모양 검사는 직접 확인해 둔다 — 서비스가 만든 키가 저장소 규칙에 맞는지.
describe('점포 이미지 키 모양', () => {
  it('stores/{점포}/{uuid}.png 는 StorageService 가 받는 키다', () => {
    expect(StorageService.newKey('stores', 11, 'PNG')).toMatch(
      /^stores\/11\/[0-9a-f-]{36}\.png$/,
    );
  });
});
