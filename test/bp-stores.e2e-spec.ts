import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from './../src/app.module';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
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
  let otherBpCodeId: number;
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
    ({ bpCodeId: otherBpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n === 999_999 ? 100_000 : n + 1}`,
        tradeName: '다른 BP',
        accountStatusCode: 'ACTIVE',
      },
    }));
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
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: [bpCodeId, otherBpCodeId] } },
    });
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

  it('플랫폼 관리자는 어느 고객 BP 든, BP 관리자는 자기 BP 만 — 다른 BP 는 없는 BP 처럼 404', async () => {
    expect((await stores(bpCodeId, paToken)).status).toBe(200);
    expect((await stores(otherBpCodeId, pmToken)).status).toBe(200);
    expect((await stores(bpCodeId, bmToken)).status).toBe(200);
    expect((await stores(otherBpCodeId, bmToken)).status).toBe(404);
    expect((await stores(bpCodeId)).status).toBe(401);
  });

  it('직원 앱은 가입 · 재직 중인 점포가 그 BP 에 없으면 404', async () => {
    // 직원 앱 토큰은 가드가 접속 상태를 확인하므로 살아 있는 접속으로 둔다. 이 계정에는 직원 레코드가 없다.
    jest
      .spyOn(app.get(AuthSessionService), 'isActive')
      .mockResolvedValueOnce(true);
    const staffToken = await app.get(JwtService).signAsync({
      sub: 2_000_000_000,
      type: 'account',
      email: 'staff@test.invalid',
      typ: 'access',
      sid: 1,
    });
    expect((await stores(bpCodeId, staffToken)).status).toBe(404);
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

    it('관리자는 권한 유형과 상관없이 그 BP 의 공통코드를 받는다 — groups 는 공개 경로와 같다', async () => {
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
      // BP · 가맹 관리자도 받는다(점포 목록과 달리 플랫폼 전용이 아니다).
      expect((await codeItems(bpCodeId, bmToken)).status).toBe(200);
      // 플랫폼 BP 도 받는다 — 공개 경로로도 보이는 값이다.
      expect((await codeItems(platformBpCodeId, bmToken)).status).toBe(200);
    });

    it('직원 앱 토큰으로도 받는다', async () => {
      // 직원 앱 토큰은 가드가 접속 상태를 확인하므로 살아 있는 접속으로 둔다.
      jest
        .spyOn(app.get(AuthSessionService), 'isActive')
        .mockResolvedValueOnce(true);
      const staffToken = await app.get(JwtService).signAsync({
        sub: 1,
        type: 'account',
        email: 'staff@test.invalid',
        typ: 'access',
        sid: 1,
      });
      expect((await codeItems(bpCodeId, staffToken)).status).toBe(200);
    });

    it('로그인하지 않으면 401, 없는 BP · 정수 범위 밖은 404', async () => {
      expect((await codeItems(bpCodeId)).status).toBe(401);
      expect((await codeItems(2_147_483_647, bmToken)).status).toBe(404);
      expect((await codeItems('99999999999', bmToken)).status).toBe(404);
      expect((await codeItems('abc', bmToken)).status).toBe(404);
    });
  });

  it('플랫폼 BP · 없는 BP · 정수 범위 밖은 404', async () => {
    expect((await stores(platformBpCodeId, pmToken)).status).toBe(404);
    expect((await stores(2_147_483_647, pmToken)).status).toBe(404);
    expect((await stores('99999999999', pmToken)).status).toBe(404);
    expect((await stores('abc', pmToken)).status).toBe(404);
  });
});
