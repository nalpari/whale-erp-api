import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { BpStoreListResponseDto } from '../src/bp-codes/dto/bp-store-list.response.dto';
import { CodeItemsResponseDto } from '../src/codes/dto/code-items.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Whale-admin-1';

// 플랫폼 마스터가 고객 BP 를 골라 들어갈 때의 점포 목록. 실제 로그인 토큰으로 권한 · 404 · 목록을 본다.
describe('BP 점포 목록 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let bpCodeId: number;
  let platformBpCodeId: number;
  const storeIds: number[] = [];
  const adminIds: number[] = [];
  let pmToken: string;
  let paToken: string;
  let bmToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const passwordHash = await hashPassword(PASSWORD);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        tradeName: '점포 목록 테스트 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
    ({ bpCodeId: platformBpCodeId } = await prisma.bpCode.findFirstOrThrow({
      where: { isPlatform: true },
    }));
    for (const [suffix, name, isDeleted] of [
      ['1', '나 점포', false],
      ['2', '가 점포', false],
      ['3', '지운 점포', true],
    ] as const) {
      const store = await prisma.store.create({
        data: {
          storeCode: `ST${String(n).slice(0, 5)}${suffix}`,
          bpCodeId,
          storeTypeCode: 'DIRECT',
          name,
          storeStatusCode: suffix === '1' ? 'CLOSED' : 'OPERATING',
          isDeleted,
        },
      });
      storeIds.push(store.storeId);
    }

    const roleGroupOf = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const loginAs = async (data: {
      bpCodeId: number;
      roleTypeCode: string;
      roleCode: string;
    }) => {
      const admin = await prisma.adminAccount.create({
        data: {
          loginId: `bps${randomInt(10_000_000, 99_999_999)}`,
          bpCodeId: data.bpCodeId,
          name: '홍길동',
          passwordHash,
          roleTypeCode: data.roleTypeCode,
          roleGroupId: await roleGroupOf(data.roleCode),
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(admin.adminAccountId);
      const res = await request(app.getHttpServer())
        .post('/auth/admin/login')
        .send({ loginId: admin.loginId, password: PASSWORD });
      return (res.body as AdminLoginResponseDto).accessToken;
    };
    pmToken = await loginAs({
      bpCodeId: platformBpCodeId,
      roleTypeCode: 'PM',
      roleCode: 'PM000001',
    });
    paToken = await loginAs({
      bpCodeId: platformBpCodeId,
      roleTypeCode: 'PA',
      roleCode: 'PM000001',
    });
    bmToken = await loginAs({
      bpCodeId,
      roleTypeCode: 'BM',
      roleCode: 'BM000001',
    });
  });

  afterAll(async () => {
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.adminLoginLog.deleteMany({ where: byAdmin });
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    await prisma.store.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const stores = (id: number | string, token?: string) => {
    const req = request(app.getHttpServer()).get(`/bp-codes/${id}/stores`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('플랫폼 마스터는 그 BP 의 미삭제 점포 전체를 이름순으로 받는다', async () => {
    const res = await stores(bpCodeId, pmToken);
    expect(res.status).toBe(200);
    const body = res.body as BpStoreListResponseDto;
    expect(body.total).toBe(2);
    expect(body.items.map((s) => s.name)).toEqual(['가 점포', '나 점포']);
    expect(body.items[1]).toMatchObject({
      storeId: storeIds[0],
      storeTypeCode: 'DIRECT',
      storeStatusCode: 'CLOSED',
    });
  });

  it('플랫폼 관리자도 받는다. 로그인하지 않으면 401, 플랫폼 사용자가 아니면 403', async () => {
    expect((await stores(bpCodeId, paToken)).status).toBe(200);
    expect((await stores(bpCodeId)).status).toBe(401);
    expect((await stores(bpCodeId, bmToken)).status).toBe(403);
  });

  describe('공통코드', () => {
    const codeItems = (
      id: number | string,
      token?: string,
      groups?: string,
    ) => {
      const req = request(app.getHttpServer())
        .get(`/bp-codes/${id}/code-items`)
        .query(groups === undefined ? {} : { groups });
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };

    it('PM · PA 는 그 BP 의 공통코드를 받는다 — groups 는 공개 경로와 같다', async () => {
      const all = await codeItems(bpCodeId, pmToken);
      expect(all.status).toBe(200);
      expect(
        (all.body as CodeItemsResponseDto).codes.STORE_TYPE.map((c) => c.value),
      ).toEqual(['DIRECT', 'FRANCHISE']);

      const some = await codeItems(bpCodeId, paToken, 'STORE_TYPE,NO_SUCH');
      expect(some.status).toBe(200);
      expect(
        Object.keys((some.body as CodeItemsResponseDto).codes).sort(),
      ).toEqual(['NO_SUCH', 'STORE_TYPE']);
      expect((await codeItems(bpCodeId, pmToken, 'bad')).status).toBe(400);
    });

    it('401 · 403 · 404 는 점포 목록과 같다', async () => {
      expect((await codeItems(bpCodeId)).status).toBe(401);
      expect((await codeItems(bpCodeId, bmToken)).status).toBe(403);
      expect((await codeItems(platformBpCodeId, pmToken)).status).toBe(404);
      expect((await codeItems('99999999999', pmToken)).status).toBe(404);
    });
  });

  it('플랫폼 BP · 없는 BP · 정수 범위 밖은 404', async () => {
    expect((await stores(platformBpCodeId, pmToken)).status).toBe(404);
    expect((await stores(2_147_483_647, pmToken)).status).toBe(404);
    expect((await stores('99999999999', pmToken)).status).toBe(404);
    expect((await stores('abc', pmToken)).status).toBe(404);
  });
});
