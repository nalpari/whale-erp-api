import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from './../src/app.module';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../src/auth/access-messages';
import { AdminLoginResponseDto } from '../src/auth/dto/admin-login.response.dto';
import { hashPassword } from '../src/auth/password';
import { BpListResponseDto } from '../src/bp-codes/dto/bp-list.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Whale-admin-1';

// 플랫폼 계정이 서비스 바로가기 「웨일ERP」에서 고를 고객 BP 목록. 실제 로그인 토큰으로 권한 · 대상 · 검색 · 쪽을 본다.
describe('BP 선택 목록 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const n = randomInt(100_000, 999_990);
  // 다른 스위트가 만든 BP 와 섞이지 않게 이 스위트의 BP 는 상호에 이 표시를 넣고 이 표시로 검색한다.
  const tag = `목록${n}`;
  const bpIds: number[] = [];
  const adminIds: number[] = [];
  const tokens: Record<string, string> = {};

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

    // 등록 시각을 BP코드 · 넣은 순서와 어긋나게 준다 — 최신 등록순(2 → 0 → 4 → 1)을 BP코드순 · id 순과 가려 본다.
    const base = Date.UTC(2020, 0, 1);
    for (const [i, accountStatusCode, isDeleted, seconds] of [
      [4, 'ACTIVE', false, 20],
      [3, 'ACTIVE', true, 0],
      [2, 'WITHDRAWN', false, 40],
      [1, 'INACTIVE', false, 10],
      [0, 'ACTIVE', false, 30],
    ] as const) {
      const bp = await prisma.bpCode.create({
        data: {
          bpCode: `BP${n + i}`,
          tradeName: `고래커피 ${tag}-${i}`,
          accountStatusCode,
          isDeleted,
          createdAt: new Date(base + seconds * 1000),
        },
      });
      bpIds[i] = bp.bpCodeId;
    }
    const { bpCodeId: platformBpCodeId } = await prisma.bpCode.findFirstOrThrow(
      { where: { isPlatform: true } },
    );

    const roleGroupOf = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const loginAs = async (
      roleTypeCode: string,
      roleCode: string,
      bpCodeId: number,
    ) => {
      const admin = await prisma.adminAccount.create({
        data: {
          loginId: `bpl${randomInt(10_000_000, 99_999_999)}`,
          bpCodeId,
          name: '홍길동',
          passwordHash,
          roleTypeCode,
          roleGroupId: await roleGroupOf(roleCode),
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(admin.adminAccountId);
      const res = await request(app.getHttpServer())
        .post('/auth/admin/login')
        .send({ loginId: admin.loginId, password: PASSWORD });
      return {
        id: admin.adminAccountId,
        token: (res.body as AdminLoginResponseDto).accessToken,
      };
    };
    tokens.PM = (await loginAs('PM', 'PM000001', platformBpCodeId)).token;
    tokens.PA = (await loginAs('PA', 'PM000001', platformBpCodeId)).token;
    tokens.BM = (await loginAs('BM', 'BM000001', bpIds[0])).token;
    tokens.BA = (await loginAs('BA', 'BM000001', bpIds[0])).token;
    tokens.FM = (await loginAs('FM', 'FM000001', bpIds[0])).token;
    tokens.FA = (await loginAs('FA', 'FM000001', bpIds[0])).token;
    const inactive = await loginAs('PM', 'PM000001', platformBpCodeId);
    tokens.inactivePM = inactive.token;
    // 로그인한 뒤 미사용으로 바꾼다 — 토큰은 살아 있어도 업무 쪽이 막아야 한다.
    await prisma.adminAccount.update({
      where: { adminAccountId: inactive.id },
      data: { accountStatusCode: 'INACTIVE' },
    });
  });

  afterAll(async () => {
    const byAdmin = { adminAccountId: { in: adminIds } };
    await prisma.adminLoginLog.deleteMany({ where: byAdmin });
    await prisma.adminSession.deleteMany({ where: byAdmin });
    await prisma.adminAccount.deleteMany({ where: byAdmin });
    // 역순으로 채우므로 beforeAll 이 중간에 실패하면 앞쪽이 비어 있다.
    await prisma.bpCode.deleteMany({
      where: { bpCodeId: { in: bpIds.filter((id) => id !== undefined) } },
    });
    await app.close();
  });

  const list = (token: string | undefined, query: Record<string, unknown>) => {
    const req = request(app.getHttpServer()).get('/bp-codes').query(query);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('플랫폼 마스터 · 관리자는 미삭제 고객 BP 를 사용 · 미사용 · 탈퇴 모두 최신 등록순으로 받는다', async () => {
    for (const role of ['PM', 'PA']) {
      const res = await list(tokens[role], { keyword: tag });
      expect(res.status).toBe(200);
      const body = res.body as BpListResponseDto;
      expect(body.total).toBe(4);
      expect(body.items).toEqual(
        [2, 0, 4, 1].map((i) => ({
          bpCodeId: bpIds[i],
          bpCode: `BP${n + i}`,
          tradeName: `고래커피 ${tag}-${i}`,
          accountStatusCode: ['ACTIVE', 'INACTIVE', 'WITHDRAWN', '', 'ACTIVE'][
            i
          ],
        })),
      );
    }
  });

  it('withMaster=true 면 BP 마스터 계정이 있는 BP 만, false · 없음은 거르지 않고, 그 밖의 값은 400', async () => {
    // BP 마스터 계정은 bpIds[0] 에만 있다(beforeAll 의 BM 로그인).
    const only = await list(tokens.PM, { keyword: tag, withMaster: 'true' });
    expect(only.status).toBe(200);
    expect(only.body).toMatchObject({
      items: [{ bpCodeId: bpIds[0] }],
      total: 1,
    });
    for (const query of [{ withMaster: 'false' }, {}]) {
      const all = await list(tokens.PM, { keyword: tag, ...query });
      expect((all.body as BpListResponseDto).total).toBe(4);
    }
    expect(
      (await list(tokens.PM, { keyword: tag, withMaster: 'yes' })).status,
    ).toBe(400);
  });

  it('BP · 가맹 관리자는 403, 직원 앱은 403, 로그인하지 않으면 401', async () => {
    for (const role of ['BM', 'BA', 'FM', 'FA']) {
      const res = await list(tokens[role], {});
      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        ACCESS_DENIED_MESSAGE,
      );
    }
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
    const staff = await list(staffToken, {});
    expect(staff.status).toBe(403);
    // 가드(@UserTypes('admin'))가 막는다 — 빠지면 sub 1 인 플랫폼 마스터로 판정돼 200 이나 다른 문구가 된다.
    expect((staff.body as { message: string }).message).toBe(
      ACCESS_DENIED_MESSAGE,
    );
    expect((await list(undefined, {})).status).toBe(401);
  });

  it('사용할 수 없는 플랫폼 계정은 403 — 사용할 수 없는 계정 문구', async () => {
    const res = await list(tokens.inactivePM, {});
    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toBe(
      ACCOUNT_UNAVAILABLE_MESSAGE,
    );
  });

  it('keyword 는 상호 · BP코드 부분 일치, 대소문자 무시, 앞뒤 공백을 자른다', async () => {
    const byCode = await list(tokens.PM, { keyword: ` bp${n + 1} ` });
    expect(
      (byCode.body as BpListResponseDto).items.map((b) => b.bpCode),
    ).toEqual([`BP${n + 1}`]);
    const byName = await list(tokens.PM, { keyword: `${tag}-2` });
    expect((byName.body as BpListResponseDto).total).toBe(1);
    // LIKE 와일드카드는 글자 그대로 — `_` 가 `-` 한 글자에 맞으면 4건이 나온다.
    const wildcard = await list(tokens.PM, { keyword: `${tag}_` });
    expect(wildcard.body).toEqual({ items: [], total: 0 });
    // 플랫폼 BP 는 검색해도 나오지 않는다.
    const platform = await list(tokens.PM, { keyword: 'BP000000' });
    expect(platform.body).toEqual({ items: [], total: 0 });
    expect((await list(tokens.PM, { keyword: 'x'.repeat(51) })).status).toBe(
      400,
    );
  });

  it('page · pageSize 로 나누고, 마지막 쪽을 넘기면 빈 목록과 total', async () => {
    const second = await list(tokens.PM, {
      keyword: tag,
      page: 2,
      pageSize: 3,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      items: [{ bpCodeId: bpIds[1] }],
      total: 4,
    });
    const beyond = await list(tokens.PM, {
      keyword: tag,
      page: 3,
      pageSize: 3,
    });
    expect(beyond.body).toEqual({ items: [], total: 4 });
    expect((await list(tokens.PM, { pageSize: 201 })).status).toBe(400);
    expect((await list(tokens.PM, { page: 0 })).status).toBe(400);
    expect((await list(tokens.PM, { page: 10_000_001 })).status).toBe(400);
  });

  it('고른 BP 가 미사용 · 탈퇴여도 점포 목록 · 공통코드는 404 가 아니다', async () => {
    for (const i of [1, 2]) {
      for (const path of ['stores', 'code-items']) {
        const res = await request(app.getHttpServer())
          .get(`/bp-codes/${bpIds[i]}/${path}`)
          .set('Authorization', `Bearer ${tokens.PM}`);
        expect(res.status).toBe(200);
      }
    }
  });
});
