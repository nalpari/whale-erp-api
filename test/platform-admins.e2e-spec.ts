import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import {
  ACCESS_DENIED_MESSAGE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
} from '../src/auth/access-messages';
import { PLATFORM_ADMIN_MAIL } from '../src/platform-admins/platform-admin-mail';
import type {
  PlatformAdminDetailResponseDto,
  PlatformAdminListResponseDto,
} from '../src/platform-admins/dto/platform-admin.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

// 경합은 연결 두 개가 필요하다 — PGlite 는 한 세션에서 차례로 돌린다. 실제 PostgreSQL 일회용 DB 에서 E2E_REAL_POSTGRES=1 로.
const onRealPostgres = process.env.E2E_REAL_POSTGRES === '1' ? it : it.skip;

/**
 * 플랫폼 관리자 관리를 실제 DB 로 — 관리자 세션 · 강제 변경 표시(가드), 메뉴 권한(MN000213), 플랫폼 BP 소속
 * 판정(isPlatformAdmin), 목록 · 상세의 관계 필터(bpCode.isPlatform), updatedAt 낙관적 잠금. 단위 테스트는
 * 이 조건들을 목의 인자로만 본다.
 *
 * 메일은 보내지 않는다(발송 수단 null) — 등록 · 초기화는 부르지 않지만, .env 에 MAIL_* 가 있어도 실수로
 * 나가지 않게 막아 둔다.
 */
describe('플랫폼 관리자 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  let customerBpCodeId: number | undefined;
  /** MN000213 을 끈 플랫폼 PA 권한 그룹. 수정 대상 계정의 그룹으로도 쓴다. */
  let paGroupId: number | undefined;
  const adminIds: number[] = [];
  /** 권한 그룹 삭제와의 경합에 쓰는 PA 권한 그룹 */
  const raceGroupIds: number[] = [];

  let pmId: number;
  let targetId: number;
  let noMenuPaId: number;
  let bmId: number;
  let customerPmId: number;
  let mustChangeId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PLATFORM_ADMIN_MAIL)
      .useValue(null)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    ({ bpCodeId: customerBpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '플랫폼 관리자 테스트 BP',
      },
    }));
    const pmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'PM000001' },
    });
    const bmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ roleGroupId: paGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n}`,
        bpCodeId: platformBp.bpCodeId,
        roleTypeCode: 'PA',
        name: `메뉴 없는 PA ${n}`,
      },
    }));
    const menu = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000213' },
    });
    // 행은 있되 네 권한이 모두 꺼진 상태 — 행이 없는 것과 같은 403 이어야 한다.
    await prisma.roleGroupMenu.create({
      data: { roleGroupId: paGroupId, menuId: menu.menuId },
    });

    const admin = async (
      prefix: string,
      data: {
        roleTypeCode: string;
        roleGroupId: number;
        bpCodeId: number;
        isPasswordChangeRequired?: boolean;
      },
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
    const platform = platformBp.bpCodeId;
    pmId = await admin('pape', {
      roleTypeCode: 'PM',
      roleGroupId: pmGroup.roleGroupId,
      bpCodeId: platform,
    });
    targetId = await admin('patg', {
      roleTypeCode: 'PA',
      roleGroupId: paGroupId,
      bpCodeId: platform,
    });
    noMenuPaId = await admin('panm', {
      roleTypeCode: 'PA',
      roleGroupId: paGroupId,
      bpCodeId: platform,
    });
    bmId = await admin('pabm', {
      roleTypeCode: 'BM',
      roleGroupId: bmGroup.roleGroupId,
      bpCodeId: customerBpCodeId,
    });
    // 역할 · 권한 그룹은 플랫폼 마스터인데 소속이 고객 BP — 메뉴 권한은 통과하고 플랫폼 판정에서 막혀야 한다.
    customerPmId = await admin('pacp', {
      roleTypeCode: 'PM',
      roleGroupId: pmGroup.roleGroupId,
      bpCodeId: customerBpCodeId,
    });
    mustChangeId = await admin('pamc', {
      roleTypeCode: 'PM',
      roleGroupId: pmGroup.roleGroupId,
      bpCodeId: platform,
      isPasswordChangeRequired: true,
    });
  });

  afterAll(async () => {
    // 준비가 중간에 실패해 id 가 비어 있으면 그 조건을 빼고 지우지 않는다 — Prisma 는 where 의 undefined 를
    // 조건 없음으로 읽어 DB 의 모든 행을 지운다.
    if (prisma) {
      if (adminIds.length) {
        const where = { adminAccountId: { in: adminIds } };
        await prisma.adminChangeHistory.deleteMany({ where });
        await prisma.adminSession.deleteMany({ where });
        await prisma.temporaryPassword.deleteMany({ where });
        // 서로를 수정자로 가리킬 수 있어 한 문장으로 지운다.
        await prisma.adminAccount.deleteMany({ where });
      }
      if (raceGroupIds.length) {
        const where = { roleGroupId: { in: raceGroupIds } };
        await prisma.roleGroupMenu.deleteMany({ where });
        await prisma.roleGroup.deleteMany({ where });
      }
      if (paGroupId !== undefined) {
        await prisma.roleGroupMenu.deleteMany({
          where: { roleGroupId: paGroupId },
        });
        await prisma.roleGroup.deleteMany({
          where: { roleGroupId: paGroupId },
        });
      }
      if (customerBpCodeId !== undefined)
        await prisma.bpCode.deleteMany({
          where: { bpCodeId: customerBpCodeId },
        });
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
  const call = async (
    method: 'get' | 'put' | 'post' | 'delete',
    path: string,
    sub: number,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return body === undefined ? req : req.send(body);
  };

  describe('권한', () => {
    it('토큰이 없으면 401', async () => {
      const res = await request(app.getHttpServer()).get('/platform-admins');
      expect(res.status).toBe(401);
    });

    it('MN000213 이 꺼진 권한 그룹의 플랫폼 관리자는 403', async () => {
      const res = await call('get', '/platform-admins', noMenuPaId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACCESS_DENIED_MESSAGE });
    });

    it('BP 계정은 403', async () => {
      const res = await call('get', '/platform-admins', bmId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACCESS_DENIED_MESSAGE });
    });

    it('고객 BP 소속 PM 은 메뉴 권한이 있어도 403', async () => {
      for (const path of [
        '/platform-admins',
        `/platform-admins/${targetId}`,
        '/platform-admins/role-groups',
      ]) {
        const res = await call('get', path, customerPmId);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ message: ACCESS_DENIED_MESSAGE });
      }
    });

    it('강제 비밀번호 변경 전이면 플랫폼 마스터도 403', async () => {
      const res = await call('get', '/platform-admins', mustChangeId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        message: PASSWORD_CHANGE_REQUIRED_MESSAGE,
      });
    });
  });

  describe('목록 · 상세', () => {
    it('플랫폼 BP 소속 PM · PA 만 나오고 고객 BP 소속 PM 은 빠진다', async () => {
      const res = await call(
        'get',
        `/platform-admins?keyword=${n}&pageSize=200`,
        pmId,
      );

      expect(res.status).toBe(200);
      const body = res.body as PlatformAdminListResponseDto;
      const ids = body.items.map((i) => i.adminAccountId);
      expect(ids).toEqual(
        expect.arrayContaining([pmId, targetId, noMenuPaId, mustChangeId]),
      );
      expect(ids).not.toContain(customerPmId);
      expect(ids).not.toContain(bmId);
      expect(body.total).toBe(4);
    });

    it('상세를 준다', async () => {
      const res = await call('get', `/platform-admins/${targetId}`, pmId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        adminAccountId: targetId,
        loginId: `patg${n}`,
        accountStatus: 'ACTIVE',
        roleGroup: { roleGroupId: paGroupId, roleTypeCode: 'PA' },
      });
    });

    it('고객 BP 소속 PM 의 상세는 404', async () => {
      const res = await call('get', `/platform-admins/${customerPmId}`, pmId);
      expect(res.status).toBe(404);
    });
  });

  describe('수정', () => {
    it('상세의 updatedAt 으로 저장하고, 그 값으로 다시 저장하면 409', async () => {
      const detail = (await call('get', `/platform-admins/${targetId}`, pmId))
        .body as PlatformAdminDetailResponseDto;
      const form = {
        name: '바뀐이름',
        phone: detail.phone,
        email: detail.email,
        roleGroupId: paGroupId,
        accountStatus: 'ACTIVE',
        updatedAt: new Date(detail.updatedAt).toISOString(),
      };

      const first = await call(
        'put',
        `/platform-admins/${targetId}`,
        pmId,
        form,
      );
      expect(first.status).toBe(204);

      const second = await call('put', `/platform-admins/${targetId}`, pmId, {
        ...form,
        name: '다시바뀐이름',
      });
      expect(second.status).toBe(409);
      await expect(
        prisma.adminAccount.findUniqueOrThrow({
          where: { adminAccountId: targetId },
          select: { name: true },
        }),
      ).resolves.toEqual({ name: '바뀐이름' });
    });

    // 연락처는 9~12자리다(2026-10-27). CHECK(admin_accounts_phone_format)가 함께 넓어져야 500 없이 저장된다 —
    // 회원가입 · 내 정보 · BP 관리자도 같은 컬럼이라 이 한 경로로 CHECK 를 본다.
    it('연락처에 12자리 · 9자리를 저장한다', async () => {
      for (const phone of ['050720331334', '021234567']) {
        const detail = (await call('get', `/platform-admins/${targetId}`, pmId))
          .body as PlatformAdminDetailResponseDto;
        const res = await call('put', `/platform-admins/${targetId}`, pmId, {
          name: detail.name,
          phone,
          email: detail.email,
          roleGroupId: paGroupId,
          accountStatus: 'ACTIVE',
          updatedAt: new Date(detail.updatedAt).toISOString(),
        });
        expect(res.status).toBe(204);
        await expect(
          prisma.adminAccount.findUniqueOrThrow({
            where: { adminAccountId: targetId },
            select: { phone: true },
          }),
        ).resolves.toEqual({ phone });
      }
    });
  });

  // 등록 · 수정은 붙일 권한 그룹을 FOR SHARE 로, 권한 그룹 삭제는 FOR UPDATE 로 잠가 서로 기다린다. 한쪽을 직접 연
  // 트랜잭션으로 잠근 채 세워 두고, 다른 쪽 요청이 그 잠금에서 기다리는 것을 확인한 뒤 나머지를 쓰고 커밋한다.
  describe('권한 그룹 삭제와 겹칠 때', () => {
    const raceGroup = async (k: number) => {
      const platformBp = await prisma.bpCode.findFirstOrThrow({
        where: { isPlatform: true },
      });
      const group = await prisma.roleGroup.create({
        data: {
          roleCode: `PA${String((n + k) % 1_000_000).padStart(6, '0')}`,
          bpCodeId: platformBp.bpCodeId,
          roleTypeCode: 'PA',
          name: `경합 PA ${n}-${k}`,
        },
      });
      raceGroupIds.push(group.roleGroupId);
      return group;
    };

    /** 플랫폼 PA 관리자를 그 그룹에 바로 만든다. */
    const raceAdmin = async (prefix: string, roleGroupId: number) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${prefix}${n}`,
          name: '경합관리자',
          phone: '01012345678',
          email: `${prefix}${n}@whale.test`,
          passwordHash: '!',
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'ACTIVE',
          roleTypeCode: 'PA',
          roleGroupId,
          bpCodeId: (
            await prisma.roleGroup.findUniqueOrThrow({
              where: { roleGroupId },
            })
          ).bpCodeId,
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };

    /**
     * 트랜잭션을 열어 lock 을 하고 release 를 부를 때까지 붙든다. 놓으면 finish 를 쓰고 커밋한다 — 다른 쪽은
     * 커밋 뒤에야 잠금을 얻으므로 finish 가 쓴 것까지 본다. locked 는 잠금을 쥔 세션의 pid 로 풀리고, 잠그기
     * 전에 트랜잭션이 실패하면 그 오류로 거부된다(타임아웃만 남지 않게).
     */
    const hold = (
      lock: (tx: Prisma.TransactionClient) => Promise<void>,
      finish: (tx: Prisma.TransactionClient) => Promise<void> = async () => {},
    ) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let markLocked!: (pid: number) => void;
      let failLocked!: (error: unknown) => void;
      const locked = new Promise<number>((resolve, reject) => {
        markLocked = resolve;
        failLocked = reject;
      });
      const done = prisma.$transaction(
        async (tx) => {
          await lock(tx);
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
            SELECT pg_backend_pid() AS pid`;
          markLocked(pid);
          await gate;
          await finish(tx);
        },
        { timeout: 20_000 },
      );
      done.catch(failLocked);
      return { locked, release, done };
    };

    /**
     * holder 가 잠금을 쥔 채로 pending 요청을 보내고, 그 요청이 holder 에 막힌 것을 확인한 뒤 놓는다. 실패해도
     * 트랜잭션과 요청이 모두 끝날 때까지 기다린다 — 정리(afterAll)보다 늦게 쓰여 행이 남지 않게. 요청 결과를 준다.
     */
    const race = async <T>(
      held: ReturnType<typeof hold>,
      send: () => Promise<T>,
    ): Promise<T> => {
      const holder = await held.locked;
      const pending = send();
      try {
        await untilWaiting(pending, holder);
      } finally {
        held.release();
        await Promise.allSettled([held.done, pending]);
      }
      await held.done;
      return pending;
    };

    /**
     * 요청이 holder 세션의 잠금을 기다리기 시작할 때까지 본다. 기다리지 않고 끝나면 경합을 만들지 못한 것이다.
     * holder 가 막고 있는 세션만 세므로, 같은 DB 의 다른 잠금 대기에 속지 않는다.
     */
    const untilWaiting = async (pending: Promise<unknown>, holder: number) => {
      let isSettled = false;
      pending.then(
        () => (isSettled = true),
        () => (isSettled = true),
      );
      for (let i = 0; i < 200 && !isSettled; i++) {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE ${holder}::int = ANY (pg_blocking_pids(pid))`;
        if (waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('요청이 권한 그룹 잠금을 기다리지 않았습니다');
    };

    onRealPostgres(
      '삭제가 그룹을 잠근 사이 들어온 등록은 삭제가 커밋된 뒤 지운 그룹을 보고 400',
      async () => {
        const group = await raceGroup(1);
        const loginId = `parc${n}`;
        // 권한 그룹 삭제와 같은 순서 — 그룹을 FOR UPDATE 로 잠그고, 연결 관리자(여기서는 없다)를 옮긴 뒤 지운다.
        const deletion = hold(
          async (tx) => {
            await tx.$queryRaw`
            SELECT role_group_id FROM role_groups
             WHERE role_group_id = ${group.roleGroupId}
               FOR UPDATE`;
          },
          async (tx) => {
            await tx.roleGroup.update({
              where: { roleGroupId: group.roleGroupId },
              data: { isDeleted: true },
            });
          },
        );
        const res = await race(deletion, () =>
          call('post', '/platform-admins', pmId, {
            loginId,
            name: '경합관리자',
            phone: '01012345678',
            email: `${loginId}@whale.test`,
            roleGroupId: group.roleGroupId,
          }),
        );

        const created = await prisma.adminAccount.findFirst({
          where: { loginId },
          select: { adminAccountId: true },
        });
        if (created) adminIds.push(created.adminAccountId);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          message: '플랫폼 관리자에게 줄 수 있는 권한이 아닙니다.',
        });
        expect(created).toBeNull();
      },
    );

    onRealPostgres(
      '등록이 그룹을 잠근 사이 들어온 삭제는 기다렸다가 그 관리자도 대체 권한으로 옮기고 이력을 남긴다',
      async () => {
        const group = await raceGroup(2);
        const replacement = await raceGroup(3);
        const loginId = `pard${n}`;
        let createdId: number | undefined;
        // 플랫폼 관리자 등록과 같은 순서 — 그룹을 FOR SHARE 로 잠그고 확인한 뒤 관리자를 만든다. 등록은 손으로
        // 흉내 내므로 이 시험이 고정하는 것은 삭제 쪽 순서(잠근 뒤 연결 관리자를 읽는다)다. 등록 쪽 잠금은 앞 시험이 본다.
        const creation = hold(
          async (tx) => {
            await tx.$queryRaw`
            SELECT role_group_id FROM role_groups
             WHERE role_group_id = ${group.roleGroupId}
               FOR SHARE`;
          },
          async (tx) => {
            ({ adminAccountId: createdId } = await tx.adminAccount.create({
              data: {
                loginId,
                name: '경합관리자',
                phone: '01012345678',
                email: `${loginId}@whale.test`,
                passwordHash: '!',
                joinPathCode: 'PLATFORM_REGISTERED',
                accountStatusCode: 'ACTIVE',
                roleTypeCode: 'PA',
                roleGroupId: group.roleGroupId,
                bpCodeId: group.bpCodeId,
              },
            }));
            adminIds.push(createdId);
          },
        );
        const res = await race(creation, () =>
          call('delete', `/platform-role-groups/${group.roleGroupId}`, pmId, {
            replacementRoleGroupId: replacement.roleGroupId,
            updatedAt: group.updatedAt.toISOString(),
          }),
        );

        expect(res.status).toBe(204);
        await expect(
          prisma.adminAccount.findUniqueOrThrow({
            where: { adminAccountId: createdId },
            select: { roleGroupId: true },
          }),
        ).resolves.toEqual({ roleGroupId: replacement.roleGroupId });
        await expect(
          prisma.adminChangeHistory.findMany({
            where: { adminAccountId: createdId },
            select: { field: true, beforeValue: true, afterValue: true },
          }),
        ).resolves.toEqual([
          {
            field: '사용자 권한',
            beforeValue: `${group.name} ${group.roleCode}`,
            afterValue: `${replacement.name} ${replacement.roleCode}`,
          },
        ]);
      },
    );

    onRealPostgres(
      '삭제가 그룹을 잠근 사이 그 그룹으로 바꾸는 수정은 삭제가 커밋된 뒤 400 이고 권한은 그대로다',
      async () => {
        const current = await raceGroup(4);
        const doomed = await raceGroup(5);
        const adminId = await raceAdmin('parx', current.roleGroupId);
        const detail = (await call('get', `/platform-admins/${adminId}`, pmId))
          .body as PlatformAdminDetailResponseDto;
        const deletion = hold(
          async (tx) => {
            await tx.$queryRaw`
            SELECT role_group_id FROM role_groups
             WHERE role_group_id = ${doomed.roleGroupId}
               FOR UPDATE`;
          },
          async (tx) => {
            await tx.roleGroup.update({
              where: { roleGroupId: doomed.roleGroupId },
              data: { isDeleted: true },
            });
          },
        );

        const res = await race(deletion, () =>
          call('put', `/platform-admins/${adminId}`, pmId, {
            name: detail.name,
            phone: detail.phone,
            email: detail.email,
            roleGroupId: doomed.roleGroupId,
            accountStatus: 'ACTIVE',
            updatedAt: new Date(detail.updatedAt).toISOString(),
          }),
        );

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          message: '플랫폼 관리자에게 줄 수 있는 권한이 아닙니다.',
        });
        await expect(
          prisma.adminAccount.findUniqueOrThrow({
            where: { adminAccountId: adminId },
            select: { roleGroupId: true },
          }),
        ).resolves.toEqual({ roleGroupId: current.roleGroupId });
      },
    );

    onRealPostgres(
      '그룹에서 다른 권한으로 옮기는 수정이 커밋 전이면 그 그룹의 삭제는 기다렸다가 그 관리자를 빼고 옮긴다',
      async () => {
        const leaving = await raceGroup(6);
        const chosen = await raceGroup(7);
        const replacement = await raceGroup(8);
        const adminId = await raceAdmin('parl', leaving.roleGroupId);
        // 플랫폼 관리자 수정과 같은 순서 — 새 그룹을 FOR SHARE 로 잠그고 관리자 행을 고친 채(행 잠금) 세워 둔다.
        const moving = hold(async (tx) => {
          await tx.$queryRaw`
            SELECT role_group_id FROM role_groups
             WHERE role_group_id = ${chosen.roleGroupId}
               FOR SHARE`;
          await tx.adminAccount.update({
            where: { adminAccountId: adminId },
            data: { roleGroupId: chosen.roleGroupId },
          });
        });

        const res = await race(moving, () =>
          call('delete', `/platform-role-groups/${leaving.roleGroupId}`, pmId, {
            replacementRoleGroupId: replacement.roleGroupId,
            updatedAt: leaving.updatedAt.toISOString(),
          }),
        );

        expect(res.status).toBe(204);
        await expect(
          prisma.adminAccount.findUniqueOrThrow({
            where: { adminAccountId: adminId },
            select: { roleGroupId: true },
          }),
        ).resolves.toEqual({ roleGroupId: chosen.roleGroupId });
        await expect(
          prisma.adminChangeHistory.count({
            where: { adminAccountId: adminId },
          }),
        ).resolves.toBe(0);
      },
    );

    // 권한을 바꾸지 않는 수정은 그룹을 잠그지 않는다. 그 사이 삭제가 관리자를 대체 권한으로 옮기면 updatedAt 이
    // 올라가므로, 수정의 저장(updatedAt 조건)은 커밋 뒤 다시 보아 409 로 막혀 지운 그룹으로 되돌리지 못한다.
    onRealPostgres(
      '삭제가 관리자를 옮기는 사이 권한을 그대로 둔 수정은 기다렸다가 409 이고 대체 권한이 남는다',
      async () => {
        const doomed = await raceGroup(9);
        const replacement = await raceGroup(10);
        const adminId = await raceAdmin('pars', doomed.roleGroupId);
        const detail = (await call('get', `/platform-admins/${adminId}`, pmId))
          .body as PlatformAdminDetailResponseDto;
        // 권한 그룹 삭제와 같은 순서 — 그룹을 잠그고 연결 관리자를 대체 권한으로 옮긴 채(행 잠금) 세워 둔다.
        const deletion = hold(
          async (tx) => {
            await tx.$queryRaw`
            SELECT role_group_id FROM role_groups
             WHERE role_group_id IN (${doomed.roleGroupId}, ${replacement.roleGroupId})
             ORDER BY role_group_id
               FOR UPDATE`;
            await tx.adminAccount.update({
              where: { adminAccountId: adminId },
              data: { roleGroupId: replacement.roleGroupId },
            });
          },
          async (tx) => {
            await tx.roleGroup.update({
              where: { roleGroupId: doomed.roleGroupId },
              data: { isDeleted: true },
            });
          },
        );

        const res = await race(deletion, () =>
          call('put', `/platform-admins/${adminId}`, pmId, {
            name: '옛화면',
            phone: detail.phone,
            email: detail.email,
            roleGroupId: doomed.roleGroupId,
            accountStatus: 'ACTIVE',
            updatedAt: new Date(detail.updatedAt).toISOString(),
          }),
        );

        expect(res.status).toBe(409);
        await expect(
          prisma.adminAccount.findUniqueOrThrow({
            where: { adminAccountId: adminId },
            select: { roleGroupId: true, name: true },
          }),
        ).resolves.toEqual({
          roleGroupId: replacement.roleGroupId,
          name: '경합관리자',
        });
      },
    );
  });
});
