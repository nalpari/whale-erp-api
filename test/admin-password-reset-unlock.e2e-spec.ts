import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PLATFORM_ADMIN_MAIL } from '../src/platform-admins/platform-admin-mail';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * 잠긴 관리자 계정을 운영자가 비밀번호 초기화하면, 메일로 받은 비밀번호로 바로 로그인된다(2026-10-28 재영 결정).
 * 단위 테스트는 초기화의 쓰기 값만 본다 — 그 값이 실제 로그인 판정의 잠금을 푸는지는 여기서 본다.
 * 플랫폼 관리자 · BP 마스터 초기화 둘 다. 메일은 보내지 않고 받은 변수를 잡아 둔다.
 */
describe('관리자 비밀번호 초기화가 로그인 잠금을 푼다 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  const adminIds: number[] = [];
  let customerBpCodeId: number | undefined;
  let pmId: number;
  let paId: number;
  let bmId: number;
  /** 보낸 메일의 받는 계정 → 임시 비밀번호 */
  const mailed = new Map<number, string>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PLATFORM_ADMIN_MAIL)
      .useValue({
        mail: {
          send: (input: {
            adminAccountId: number;
            variables: Record<string, string>;
          }) => {
            mailed.set(input.adminAccountId, input.variables['임시비밀번호']);
            return Promise.resolve({});
          },
        },
        webUrl: 'https://admin.e2e.test',
      })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const group = (roleCode: string) =>
      prisma.roleGroup.findFirstOrThrow({ where: { roleCode } });
    ({ bpCodeId: customerBpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '초기화 잠금 해제 테스트 BP',
      },
    }));
    const admin = async (
      prefix: string,
      data: { roleTypeCode: string; roleGroupId: number; bpCodeId: number },
    ) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${prefix}${n}`,
          name: '테스트관리자',
          phone: '01012345678',
          email: `${prefix}${n}@whale.test`,
          passwordHash: '!',
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          ...data,
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };
    const pmGroupId = (await group('PM000001')).roleGroupId;
    pmId = await admin('rupm', {
      roleTypeCode: 'PM',
      roleGroupId: pmGroupId,
      bpCodeId: platformBp.bpCodeId,
    });
    // 초기화 대상 플랫폼 관리자. 초기 데이터에 PA 고정 그룹이 없어 PM 그룹을 빌린다 — 로그인 판정은 그룹을 보지 않는다.
    paId = await admin('rupa', {
      roleTypeCode: 'PA',
      roleGroupId: pmGroupId,
      bpCodeId: platformBp.bpCodeId,
    });
    bmId = await admin('rubm', {
      roleTypeCode: 'BM',
      roleGroupId: (await group('BM000001')).roleGroupId,
      bpCodeId: customerBpCodeId,
    });
  });

  afterAll(async () => {
    // 준비가 중간에 실패해 id 가 비어 있으면 그 조건을 빼고 지우지 않는다 — Prisma 는 where 의 undefined 를
    // 조건 없음으로 읽어 DB 의 모든 행을 지운다.
    if (prisma) {
      if (adminIds.length) {
        const where = { adminAccountId: { in: adminIds } };
        await prisma.adminLoginLog.deleteMany({ where });
        await prisma.adminChangeHistory.deleteMany({ where });
        await prisma.adminSession.deleteMany({ where });
        await prisma.temporaryPassword.deleteMany({ where });
        await prisma.adminAccount.deleteMany({ where });
      }
      if (customerBpCodeId !== undefined) {
        await prisma.bpChangeHistory.deleteMany({
          where: { bpCodeId: customerBpCodeId },
        });
        await prisma.bpCode.deleteMany({
          where: { bpCodeId: customerBpCodeId },
        });
      }
    }
    await app?.close();
  });

  // 관리자 토큰은 살아 있는 관리자 세션(admin_sessions)이 있어야 가드를 통과한다.
  const tokenOf = async (sub: number) =>
    (
      await app.get(AdminSessionService).issue({ adminAccountId: sub }, (sid) =>
        app.get(JwtService).signAsync({
          sub,
          type: 'admin',
          loginId: `admin${sub}`,
          typ: 'access',
          sid,
        }),
      )
    ).accessToken;
  const reset = async (path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${await tokenOf(pmId)}`);
  const login = (loginId: string, password: string) =>
    request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ loginId, password });

  const lockedLoginAfterReset = async (
    adminAccountId: number,
    loginId: string,
    path: string,
  ) => {
    // 다섯 번 틀려 막 잠긴 상태 — 잠금은 5분 뒤에 끝난다.
    await prisma.adminAccount.update({
      where: { adminAccountId },
      data: {
        failedLoginCount: 5,
        lockExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    expect((await login(loginId, 'whatever')).status).toBe(429);

    expect((await reset(path)).status).toBe(200);
    const password = mailed.get(adminAccountId);
    expect(password).toBeDefined();

    const res = await login(loginId, password!);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      account: { isPasswordChangeRequired: true },
    });
  };

  it('플랫폼 관리자 초기화', () =>
    lockedLoginAfterReset(
      paId,
      `rupa${n}`,
      `/platform-admins/${paId}/password-reset`,
    ));

  it('BP 마스터 초기화', () =>
    lockedLoginAfterReset(
      bmId,
      `rubm${n}`,
      `/bp-masters/${customerBpCodeId}/password-reset`,
    ));
});
