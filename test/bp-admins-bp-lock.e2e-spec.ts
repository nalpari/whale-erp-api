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

// BP 관리자 등록이 BP 미사용 전환 · 삭제와 겹칠 때 둘 중 하나만 이기는지(bp_codes 행 잠금, PR #163 리뷰).
// 연결 두 개가 필요해 실제 PostgreSQL 일회용 DB 에서 E2E_REAL_POSTGRES=1 로만 돈다 — PGlite 는 세션이 하나다.
// 미사용 전환 · 삭제는 /bp-masters(PR #163)와 같은 순서로 잠그는 SQL 로 흉내 낸다: bp_codes → admin_accounts.
const onRealPostgres = process.env.E2E_REAL_POSTGRES === '1' ? it : it.skip;

describe('BP 관리자 등록 · BP 잠금 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const n = randomInt(100_000, 900_000);
  let seq = 0;
  const bpIds: number[] = [];
  let bmGroupId: number;

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PLATFORM_ADMIN_MAIL)
      .useValue({
        mail: { send: () => Promise.resolve({ messageId: 'e2e' }) },
        webUrl: 'https://admin.e2e.test',
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.listen(0);
    prisma = app.get(PrismaService);
    ({ roleGroupId: bmGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    }));
  });

  afterAll(async () => {
    if (!prisma) return;
    if (bpIds.length) {
      const admins = { bpCodeId: { in: bpIds } };
      const ids = (
        await prisma.adminAccount.findMany({
          where: admins,
          select: { adminAccountId: true },
        })
      ).map((a) => a.adminAccountId);
      await prisma.adminChangeHistory.deleteMany({
        where: {
          OR: [{ adminAccountId: { in: ids } }, { changedBy: { in: ids } }],
        },
      });
      await prisma.temporaryPassword.deleteMany({
        where: { adminAccountId: { in: ids } },
      });
      await prisma.mailSendLog.deleteMany({
        where: { adminAccountId: { in: ids } },
      });
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: { in: ids } },
      });
      await prisma.adminAccount.updateMany({
        where: admins,
        data: { roleGroupId: bmGroupId, createdBy: null, updatedBy: null },
      });
      await prisma.roleGroup.deleteMany({ where: { bpCodeId: { in: bpIds } } });
      await prisma.adminAccount.deleteMany({ where: admins });
      await prisma.bpCode.deleteMany({ where: { bpCodeId: { in: bpIds } } });
    }
    await app.close();
  });

  /** 시험마다 새 BP — BP 마스터 하나와 BA 권한 그룹 하나만 있다. */
  const freshBp = async () => {
    const k = n + seq++;
    const { bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${k}`,
        accountStatusCode: 'ACTIVE',
        tradeName: 'BP 잠금 테스트',
      },
    });
    bpIds.push(bpCodeId);
    const { adminAccountId: bmId } = await prisma.adminAccount.create({
      data: {
        loginId: `bplk${k}`,
        name: '시험BM',
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: bmGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    });
    const { roleGroupId: baGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${k}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `BA 잠금 ${k}`,
      },
    });
    const token = (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: bmId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: bmId,
            type: 'admin',
            loginId: `bplk${k}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
    const createBa = () =>
      request(app.getHttpServer())
        .post('/bp-admins')
        .set('Authorization', `Bearer ${token}`)
        .send({
          loginId: `bpla${k}`,
          name: '새BA',
          phone: '01012345678',
          email: `bpla${k}@e2e.test`,
          roleTypeCode: 'BA',
          roleGroupId: baGroupId,
          isAllStores: true,
          storeIds: [],
        })
        .then((res) => res);
    return { bpCodeId, baGroupId, createBa, newLoginId: `bpla${k}` };
  };

  /** 다른 연결에서 연 트랜잭션. fn 이 끝난 뒤 release() 를 부를 때까지 커밋하지 않는다. */
  const hold = (fn: (tx: PrismaService) => Promise<unknown>) => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const done = prisma.$transaction(
      async (tx) => {
        await fn(tx as PrismaService);
        ready();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return { isReady, release, done };
  };
  /** 행 잠금을 기다리는 연결이 count 개가 될 때까지 기다린다. */
  const waitForLockWaiters = async (count: number) => {
    for (let i = 0; i < 100; i++) {
      const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
        SELECT count(*)::int AS c FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if (c >= count) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`잠금 대기 ${count}건이 생기지 않았다`);
  };
  const deactivate = (bpCodeId: number) => async (tx: PrismaService) => {
    await tx.$executeRaw`UPDATE bp_codes SET account_status_code = 'INACTIVE' WHERE bp_code_id = ${bpCodeId}`;
    await tx.$executeRaw`UPDATE admin_accounts SET account_status_code = 'INACTIVE'
      WHERE bp_code_id = ${bpCodeId} AND account_status_code = 'ACTIVE' AND NOT is_deleted`;
  };
  const statusOf = async (loginId: string) =>
    (await prisma.adminAccount.findFirst({ where: { loginId } }))
      ?.accountStatusCode;

  onRealPostgres('미사용 전환이 먼저면 등록은 409, 계정은 없다', async () => {
    const { bpCodeId, createBa, newLoginId } = await freshBp();
    const off = hold(deactivate(bpCodeId));
    await off.isReady;
    const pending = createBa();
    await waitForLockWaiters(1);
    off.release();
    await off.done;
    const res = await pending;
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      'BP 가 미사용이라 사용 계정을 둘 수 없습니다',
    );
    expect(await statusOf(newLoginId)).toBeUndefined();
  });

  onRealPostgres(
    '등록이 먼저면 미사용 전환이 새 계정까지 미사용으로 내린다',
    async () => {
      const { bpCodeId, baGroupId, createBa, newLoginId } = await freshBp();
      // 등록을 BP 잠금 직후(권한 그룹 잠금)에서 붙잡는다
      const gate = hold(
        (tx) =>
          tx.$queryRaw`SELECT 1 FROM role_groups WHERE role_group_id = ${baGroupId} FOR UPDATE`,
      );
      await gate.isReady;
      const pending = createBa();
      await waitForLockWaiters(1);
      const off = hold(deactivate(bpCodeId));
      await waitForLockWaiters(2);
      gate.release();
      await gate.done;
      expect((await pending).status).toBe(201);
      await off.isReady;
      off.release();
      await off.done;
      expect(await statusOf(newLoginId)).toBe('INACTIVE');
    },
  );

  onRealPostgres('삭제가 먼저면 등록은 404, 계정은 없다', async () => {
    const { bpCodeId, createBa, newLoginId } = await freshBp();
    const del = hold(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM bp_codes WHERE bp_code_id = ${bpCodeId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE bp_codes SET is_deleted = true WHERE bp_code_id = ${bpCodeId}`;
    });
    await del.isReady;
    const pending = createBa();
    await waitForLockWaiters(1);
    del.release();
    await del.done;
    const res = await pending;
    expect(res.status).toBe(404);
    expect((res.body as { message: string }).message).toBe(
      'BP 를 찾을 수 없습니다',
    );
    expect(await statusOf(newLoginId)).toBeUndefined();
  });

  onRealPostgres(
    '등록이 먼저면 삭제는 잠근 뒤 새 하위 관리자를 본다(삭제 409 의 근거)',
    async () => {
      const { bpCodeId, baGroupId, createBa } = await freshBp();
      const gate = hold(
        (tx) =>
          tx.$queryRaw`SELECT 1 FROM role_groups WHERE role_group_id = ${baGroupId} FOR UPDATE`,
      );
      await gate.isReady;
      const pending = createBa();
      await waitForLockWaiters(1);
      let subAdmins = -1;
      const del = hold(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM bp_codes WHERE bp_code_id = ${bpCodeId} FOR UPDATE`;
        [{ c: subAdmins }] = await tx.$queryRaw<{ c: number }[]>`
          SELECT count(*)::int AS c FROM admin_accounts
          WHERE bp_code_id = ${bpCodeId} AND role_type_code <> 'BM' AND NOT is_deleted`;
      });
      await waitForLockWaiters(2);
      gate.release();
      await gate.done;
      expect((await pending).status).toBe(201);
      await del.isReady;
      del.release();
      await del.done;
      expect(subAdmins).toBe(1);
    },
  );
});
