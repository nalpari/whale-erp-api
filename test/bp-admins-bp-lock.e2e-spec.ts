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

// BP 관리자 등록 · 수정이 BP 미사용 전환 · 삭제와 겹칠 때 둘 중 하나만 이기는지(bp_codes 행 잠금, PR #163 리뷰).
// 연결 두 개가 필요해 실제 PostgreSQL 일회용 DB 에서 E2E_REAL_POSTGRES=1 로만 돈다 — PGlite 는 세션이 하나다.
// /bp-masters(PR #163)가 main 에 없어 SQL 로 흉내 낸다 — 미사용 전환은 bp_codes 를 고친 뒤 admin_accounts 를 내리고,
// 삭제는 bp_codes 를 FOR UPDATE 로 잡고 삭제 표시만 한다. 「등록 먼저 → 삭제」는 삭제가 새 하위 관리자를 보는 데까지만
// 본다(그 뒤의 409 는 /bp-masters 의 몫).
const onRealPostgres = process.env.E2E_REAL_POSTGRES === '1' ? it : it.skip;
// 잠금을 붙잡았다 푸는 시험이라 기본 5초는 빠듯하다.
jest.setTimeout(30_000);

describe('BP 관리자 등록 · 수정 · BP 잠금 (e2e, DB)', () => {
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
    /** 이미 있는 사용 중 BA 하나, 옮겨 갈 BA 권한 그룹 하나, 그 계정을 고치는 요청. */
    const seedBa = async () => {
      const { roleGroupId: otherGroupId } = await prisma.roleGroup.create({
        data: {
          roleCode: `BA${((k + 500_000) % 900_000) + 100_000}`, // role_code CHECK 는 6자리
          bpCodeId,
          roleTypeCode: 'BA',
          name: `BA 잠금 다른 ${k}`,
        },
      });
      const ba = await prisma.adminAccount.create({
        data: {
          loginId: `bplb${k}`,
          name: '기존BA',
          email: `bplb${k}@e2e.test`,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode: 'BA',
          roleGroupId: baGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
      const updateBa = (name: string, roleGroupId = baGroupId) =>
        request(app.getHttpServer())
          .put(`/bp-admins/${ba.adminAccountId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name,
            phone: '01012345678',
            email: `bplb${k}@e2e.test`,
            roleGroupId,
            isAllStores: true,
            storeIds: [],
            accountStatus: 'ACTIVE',
            updatedAt: ba.updatedAt.toISOString(),
          })
          .then((res) => res);
      return { baId: ba.adminAccountId, otherGroupId, updateBa };
    };
    return { bpCodeId, baGroupId, createBa, newLoginId: `bpla${k}`, seedBa };
  };

  /** 시험이 실패해도 afterEach 가 풀고 기다린다 — 잠금이 남으면 정리가 막히고 원인이 시간 초과에 묻힌다. */
  const open: { release: () => void; done: Promise<unknown> }[] = [];
  const inflight: Promise<unknown>[] = [];
  afterEach(async () => {
    open.forEach((h) => h.release());
    await Promise.allSettled([...open.map((h) => h.done), ...inflight]);
    open.length = inflight.length = 0;
  });
  const send = <T>(p: Promise<T>) => (inflight.push(p), p);

  /**
   * 다른 연결에서 연 트랜잭션. fn 이 끝난 뒤 release() 를 부를 때까지 커밋하지 않는다. pid 는 fn 전에, locked 는 fn
   * 뒤에 풀린다. fn 이 실패하면 locked 가 그 오류로 끝난다 — 「5초 초과」 대신 Postgres 오류가 보이게.
   */
  const hold = (fn: (tx: PrismaService) => Promise<unknown>) => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let onPid!: (pid: number) => void;
    const pid = new Promise<number>((r) => (onPid = r));
    let onLocked!: () => void;
    const isLocked = new Promise<void>((r) => (onLocked = r));
    const done = prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        onPid(row.pid);
        await fn(tx as PrismaService);
        onLocked();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const ended = done.then(() => {
      throw new Error('잠그기 전에 트랜잭션이 끝났다');
    });
    const held = {
      pid: Promise.race([pid, ended]),
      locked: Promise.race([isLocked, ended]),
      release,
      done,
    };
    open.push(held);
    return held;
  };
  /**
   * condition 이 참이 될 때까지 본다. 요청이 기다리지 않고 끝나면 경합을 만들지 못한 것이라 바로 실패한다. 앱 트랜잭션
   * 기본 한도(5초)보다 짧게 본다 — 붙잡힌 요청이 시간 초과로 500 이 되기 전에.
   */
  const until = async (
    what: string,
    pending: Promise<unknown>,
    condition: () => Promise<boolean>,
  ) => {
    let isSettled = false;
    pending.then(
      () => (isSettled = true),
      () => (isSettled = true),
    );
    for (let i = 0; i < 80 && !isSettled; i++) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${what} — 생기지 않았다`);
  };
  /** holder 가 막고 있는 세션이 생겼다. holder 기준으로만 세므로 같은 DB 의 다른 suite 잠금 대기에 속지 않는다. */
  const blockedBy = (holder: number) => async () => {
    const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_stat_activity
       WHERE ${holder}::int = ANY (pg_blocking_pids(pid))`;
    return c > 0;
  };
  /** waiter 세션이 잠금을 기다린다(막는 쪽은 붙잡힌 요청의 연결이라 pid 를 모른다). */
  const isWaiting = (waiter: number) => async () => {
    const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int AS c FROM pg_stat_activity
       WHERE pid = ${waiter}::int AND cardinality(pg_blocking_pids(pid)) > 0`;
    return c > 0;
  };
  const lockRoleGroup = (roleGroupId: number) => (tx: PrismaService) =>
    tx.$queryRaw`SELECT 1 FROM role_groups WHERE role_group_id = ${roleGroupId} FOR UPDATE`;
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
    await off.locked;
    const pending = send(createBa());
    await until(
      '등록이 미사용 전환을 기다림',
      pending,
      blockedBy(await off.pid),
    );
    off.release();
    await off.done;
    const res = await pending;
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      'BP 가 사용 중이 아니라 사용 계정을 둘 수 없습니다',
    );
    expect(await statusOf(newLoginId)).toBeUndefined();
  });

  onRealPostgres(
    '등록이 먼저면 미사용 전환이 새 계정까지 미사용으로 내린다',
    async () => {
      const { bpCodeId, baGroupId, createBa, newLoginId } = await freshBp();
      // 등록을 BP 잠금 직후(권한 그룹 잠금)에서 붙잡는다
      const gate = hold(lockRoleGroup(baGroupId));
      await gate.locked;
      const pending = send(createBa());
      await until(
        '등록이 권한 그룹에서 멈춤',
        pending,
        blockedBy(await gate.pid),
      );
      const off = hold(deactivate(bpCodeId));
      await until(
        '미사용 전환이 등록의 BP 잠금을 기다림',
        pending,
        isWaiting(await off.pid),
      );
      gate.release();
      await gate.done;
      // 미사용 전환이 새 계정 행을 잡은 채 기다리면 등록의 커밋 뒤 마무리(markSent)가 그 행에서 막힌다 — 응답보다 먼저 푼다.
      await off.locked;
      off.release();
      await off.done;
      expect((await pending).status).toBe(201);
      expect(await statusOf(newLoginId)).toBe('INACTIVE');
    },
  );

  onRealPostgres('삭제가 먼저면 등록은 404, 계정은 없다', async () => {
    const { bpCodeId, createBa, newLoginId } = await freshBp();
    const del = hold(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM bp_codes WHERE bp_code_id = ${bpCodeId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE bp_codes SET is_deleted = true WHERE bp_code_id = ${bpCodeId}`;
    });
    await del.locked;
    const pending = send(createBa());
    await until('등록이 삭제를 기다림', pending, blockedBy(await del.pid));
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
      const gate = hold(lockRoleGroup(baGroupId));
      await gate.locked;
      const pending = send(createBa());
      await until(
        '등록이 권한 그룹에서 멈춤',
        pending,
        blockedBy(await gate.pid),
      );
      let subAdmins = -1;
      const del = hold(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM bp_codes WHERE bp_code_id = ${bpCodeId} FOR UPDATE`;
        [{ c: subAdmins }] = await tx.$queryRaw<{ c: number }[]>`
          SELECT count(*)::int AS c FROM admin_accounts
          WHERE bp_code_id = ${bpCodeId} AND role_type_code <> 'BM' AND NOT is_deleted`;
      });
      await until(
        '삭제가 등록의 BP 잠금을 기다림',
        pending,
        isWaiting(await del.pid),
      );
      gate.release();
      await gate.done;
      expect((await pending).status).toBe(201);
      await del.locked;
      del.release();
      await del.done;
      expect(subAdmins).toBe(1);
    },
  );

  onRealPostgres(
    '미사용 전환이 먼저면 사용으로 저장은 409, 계정은 미사용 그대로',
    async () => {
      const { bpCodeId, seedBa } = await freshBp();
      const { baId, updateBa } = await seedBa();
      const off = hold(deactivate(bpCodeId));
      await off.locked;
      const pending = send(updateBa('바꾼이름'));
      await until(
        '수정이 미사용 전환을 기다림',
        pending,
        blockedBy(await off.pid),
      );
      off.release();
      await off.done;
      const res = await pending;
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'BP 가 사용 중이 아니라 사용 계정을 둘 수 없습니다',
      );
      const after = await prisma.adminAccount.findUniqueOrThrow({
        where: { adminAccountId: baId },
      });
      expect(after).toMatchObject({
        accountStatusCode: 'INACTIVE',
        name: '기존BA',
      });
    },
  );

  onRealPostgres(
    '수정이 먼저면 미사용 전환이 고친 계정까지 미사용으로 내린다',
    async () => {
      const { bpCodeId, seedBa } = await freshBp();
      const { baId, otherGroupId, updateBa } = await seedBa();
      // 수정을 BP 잠금 뒤(바꿀 권한 그룹 잠금)에서 붙잡는다 — 계정 행으로 붙잡으면 미사용 전환도 거기서 기다려
      // BP 잠금 없이도 통과한다.
      const gate = hold(lockRoleGroup(otherGroupId));
      await gate.locked;
      const pending = send(updateBa('바꾼이름', otherGroupId));
      await until(
        '수정이 권한 그룹에서 멈춤',
        pending,
        blockedBy(await gate.pid),
      );
      const off = hold(deactivate(bpCodeId));
      await until(
        '미사용 전환이 수정의 BP 잠금을 기다림',
        pending,
        isWaiting(await off.pid),
      );
      gate.release();
      await gate.done;
      expect((await pending).status).toBe(204);
      await off.locked;
      off.release();
      await off.done;
      const after = await prisma.adminAccount.findUniqueOrThrow({
        where: { adminAccountId: baId },
      });
      expect(after).toMatchObject({
        accountStatusCode: 'INACTIVE',
        name: '바꾼이름',
      });
    },
  );
});
