// 응답 본문(supertest 의 any)을 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

// BP 권한 그룹 관리(MN000013)를 실제 DB 로 확인한다. 역할 5종의 범위, 가맹 마스터별 이름 중복(부분 고유 인덱스),
// 상한(기준 고정 권한 ∩ 본인 권한), 삭제의 관리자 이관은 단위 테스트가 목으로 가정만 하므로 여기서만 증명된다.
// 실제 PostgreSQL 에서만 도는 동시성 검사. PGlite 는 세션이 하나라 advisory lock 이 줄을 세우지 못한다(stores-db 와 같다).
const onRealPostgres = process.env.E2E_REAL_POSTGRES === '1' ? it : it.skip;

describe('BP 권한 그룹 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 990_000);
  const adminIds: number[] = [];

  let bpId: number | undefined;
  let platformBpId: number;
  let pmGroupId: number;
  let baGroupId: number;
  let faGroupId: number;

  let pmId: number;
  let bmId: number;
  let baId: number;
  let fm1Id: number;
  let fm2Id: number;
  let faId: number;
  let lonelyFaId: number;

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.listen(0);
    prisma = app.get(PrismaService);

    ({ bpCodeId: platformBpId } = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    }));
    const fixed = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    pmGroupId = await fixed('PM000001');
    const bmGroupId = await fixed('BM000001');
    const fmGroupId = await fixed('FM000001');
    const { menuId: roleMenuId } = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000013' },
    });

    ({ bpCodeId: bpId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: 'BP 권한 그룹 테스트',
      },
    }));

    const admin = async (
      prefix: string,
      roleTypeCode: string,
      roleGroupId: number,
      bpCodeId = bpId!,
    ) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${prefix}${n}`,
          name: `시험${prefix}`,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };
    pmId = await admin('bgpm', 'PM', pmGroupId, platformBpId);
    bmId = await admin('bgbm', 'BM', bmGroupId);
    fm1Id = await admin('bgfa', 'FM', fmGroupId);
    fm2Id = await admin('bgfb', 'FM', fmGroupId);

    // 관리자 그룹 — 조회만 가진 BA 그룹, 가맹 마스터 1 의 FA 그룹
    const group = async (
      roleCode: string,
      roleTypeCode: string,
      managerAdminAccountId: number | null,
    ) => {
      const { roleGroupId } = await prisma.roleGroup.create({
        data: {
          roleCode,
          bpCodeId: bpId!,
          roleTypeCode,
          name: `${roleTypeCode} 시험 ${n}`,
          managerAdminAccountId,
        },
      });
      await prisma.roleGroupMenu.create({
        data: { roleGroupId, menuId: roleMenuId, isReadable: true },
      });
      return roleGroupId;
    };
    baGroupId = await group(`BA${n}`, 'BA', null);
    faGroupId = await group(`FA${n}`, 'FA', fm1Id);
    baId = await admin('bgba', 'BA', baGroupId);
    faId = await admin('bgfx', 'FA', faGroupId);
    const lonelyGroupId = await group(`FA${n + 1}`, 'FA', null);
    lonelyFaId = await admin('bgfl', 'FA', lonelyGroupId);
  });

  afterAll(async () => {
    if (!prisma) return;
    if (adminIds.length) {
      await prisma.adminChangeHistory.deleteMany({
        where: {
          OR: [
            { adminAccountId: { in: adminIds } },
            { changedBy: { in: adminIds } },
          ],
        },
      });
      await prisma.adminAccount.updateMany({
        where: { adminAccountId: { in: adminIds } },
        data: { roleGroupId: pmGroupId, updatedBy: null, createdBy: null },
      });
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: { in: adminIds } },
      });
    }
    if (bpId !== undefined) {
      await prisma.roleGroupMenu.deleteMany({
        where: { roleGroup: { bpCodeId: bpId } },
      });
      await prisma.roleGroup.deleteMany({ where: { bpCodeId: bpId } });
    }
    if (adminIds.length)
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: { in: adminIds } },
      });
    if (bpId !== undefined)
      await prisma.bpCode.deleteMany({ where: { bpCodeId: bpId } });
    await app.close();
  });

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
  const ids = (res: { body: any }) =>
    res.body.items.map((i: any) => i.roleGroupId as number);
  const create = async (sub: number, name: string) => {
    const res = await call('post', '/bp-role-groups', sub, { name });
    expect(res.status).toBe(201);
    return res.body as { roleGroupId: number; roleCode: string };
  };
  const detailOf = async (sub: number, id: number) =>
    (await call('get', `/bp-role-groups/${id}`, sub)).body;
  /** 트리의 일반 메뉴 칸을 평평하게 — 묶음 메뉴는 하위에서 정해지므로 뺀다. */
  const leaves = (tree: any) => {
    const out: any[] = [];
    const walk = (nodes: any[]) => {
      for (const node of nodes) {
        if (!node.isGroup) out.push(node);
        walk(node.children);
      }
    };
    for (const s of tree.services) walk(s.menus);
    return out;
  };
  const cellsOf = (node: any, patch: Record<string, boolean> = {}) => ({
    menuId: node.menuId,
    read: node.read.value,
    create: node.create.value,
    update: node.update.value,
    delete: node.delete.value,
    ...patch,
  });

  describe('호출자 범위', () => {
    it('토큰이 없으면 401', async () => {
      await request(app.getHttpServer()).get('/bp-role-groups').expect(401);
    });

    it('플랫폼 사용자는 bpCodeId 가 필수(400)이고, 주면 그 BP 의 BA + FA 를 조회만 한다', async () => {
      expect((await call('get', '/bp-role-groups', pmId)).status).toBe(400);
      const res = await call('get', `/bp-role-groups?bpCodeId=${bpId}`, pmId);
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual(expect.arrayContaining([baGroupId, faGroupId]));
      expect(res.body.creatableRoleTypeCode).toBeNull();
      expect(
        (
          await call('post', `/bp-role-groups?bpCodeId=${bpId}`, pmId, {
            name: '플랫폼 등록',
          })
        ).status,
      ).toBe(403);
    });

    it('BM 은 자기 BP 의 BA + FA 를 보고 BA 를 등록한다. 다른 BP 를 주면 403', async () => {
      const res = await call('get', '/bp-role-groups', bmId);
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual(expect.arrayContaining([baGroupId, faGroupId]));
      expect(res.body.creatableRoleTypeCode).toBe('BA');
      // BA 가 FA 보다 먼저 온다(권한 코드 순)
      const types = res.body.items.map((i: any) => i.roleTypeCode);
      expect(types.indexOf('BA')).toBeLessThan(types.indexOf('FA'));
      expect(
        res.body.items.find((i: any) => i.roleGroupId === faGroupId).manager,
      ).toMatchObject({ adminAccountId: fm1Id });
      expect(
        (await call('get', `/bp-role-groups?bpCodeId=${platformBpId}`, bmId))
          .status,
      ).toBe(403);
    });

    it('BA 는 보기만 한다 — 역할 판정이 본인 연결보다 먼저라 모두 NO_PERMISSION, 등록 403', async () => {
      expect(await detailOf(baId, baGroupId)).toMatchObject({
        isSelfLinked: true,
        isEditable: false,
        editBlockedReason: 'NO_PERMISSION',
      });
      expect(await detailOf(baId, faGroupId)).toMatchObject({
        editBlockedReason: 'NO_PERMISSION',
      });
      expect(
        (await call('post', '/bp-role-groups', baId, { name: 'x' })).status,
      ).toBe(403);
    });

    it('FM 은 본인 FA 만 본다 — BA · 다른 가맹 마스터의 FA 는 404', async () => {
      const res = await call('get', '/bp-role-groups', fm1Id);
      expect(ids(res)).toEqual([faGroupId]);
      expect(res.body.creatableRoleTypeCode).toBe('FA');
      expect(
        (await call('get', `/bp-role-groups/${baGroupId}`, fm1Id)).status,
      ).toBe(404);
      expect(
        (await call('get', `/bp-role-groups/${faGroupId}`, fm2Id)).status,
      ).toBe(404);
    });

    it('FA 는 연결 가맹 마스터의 FA 만 보고, 연결이 없으면 403', async () => {
      expect(ids(await call('get', '/bp-role-groups', faId))).toEqual([
        faGroupId,
      ]);
      expect((await call('get', '/bp-role-groups', lonelyFaId)).status).toBe(
        403,
      );
    });
  });

  describe('등록 · 이름 중복', () => {
    it('FA 이름은 가맹 마스터마다 따로, BA 와도 따로 판정한다', async () => {
      const name = `중복 시험 ${n}`;
      const fa1 = await create(fm1Id, name);
      expect(fa1.roleCode).toMatch(/^FA\d{6}$/);
      expect(await detailOf(fm1Id, fa1.roleGroupId)).toMatchObject({
        roleTypeCode: 'FA',
        manager: { adminAccountId: fm1Id },
        isEditable: true,
      });
      await create(fm2Id, name);
      const ba = await create(bmId, name);
      expect(ba.roleCode).toMatch(/^BA\d{6}$/);
      expect(
        (await call('post', '/bp-role-groups', fm1Id, { name })).status,
      ).toBe(409);
      expect(
        (await call('post', '/bp-role-groups', bmId, { name })).status,
      ).toBe(409);
    });

    onRealPostgres(
      '동시에 같은 이름을 등록하면 하나만 된다(부분 고유 인덱스)',
      async () => {
        const name = `동시 시험 ${n}`;
        // 세션을 동시에 발급하면 서로 끊으므로 토큰은 하나를 먼저 받아 쓴다.
        const token = await tokenOf(bmId);
        const results = await Promise.all(
          [1, 2, 3].map(() =>
            request(app.getHttpServer())
              .post('/bp-role-groups')
              .set('Authorization', `Bearer ${token}`)
              .send({ name }),
          ),
        );
        expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      },
    );
  });

  describe('수정', () => {
    it('BM 은 BA 이름을 고치고, 같은 updatedAt 을 다시 보내면 409', async () => {
      const { roleGroupId } = await create(bmId, `수정 전 ${n}`);
      const { updatedAt } = await detailOf(bmId, roleGroupId);
      const body = { name: `수정 후 ${n}`, updatedAt };
      expect(
        (await call('put', `/bp-role-groups/${roleGroupId}`, bmId, body))
          .status,
      ).toBe(204);
      expect(
        (await call('put', `/bp-role-groups/${roleGroupId}`, bmId, body))
          .status,
      ).toBe(409);
    });

    it('BM 이 FA 를 · 플랫폼 사용자가 고치면 403', async () => {
      const { updatedAt } = await detailOf(bmId, faGroupId);
      const body = { name: '못 고침', updatedAt };
      expect(
        (await call('put', `/bp-role-groups/${faGroupId}`, bmId, body)).status,
      ).toBe(403);
      expect(
        (
          await call(
            'put',
            `/bp-role-groups/${faGroupId}?bpCodeId=${bpId}`,
            pmId,
            body,
          )
        ).status,
      ).toBe(403);
    });
  });

  describe('메뉴', () => {
    // BM000001 은 WHALE_ERP 일반 메뉴를 모두 허용해 상한 밖 칸이 없다. 칸이 일부 꺼진 FM000001 로 본다.
    it('트리는 WHALE_ERP 만, 상한(FM000001 ∩ 본인) 안은 저장되고 밖은 400', async () => {
      const { roleGroupId } = await create(fm1Id, `메뉴 시험 ${n}`);
      const tree = (
        await call('get', `/bp-role-groups/${roleGroupId}/menus`, fm1Id)
      ).body;
      expect(tree.isSavable).toBe(true);
      expect(tree.services.map((s: any) => s.serviceCode)).toEqual([
        'WHALE_ERP',
      ]);
      const nodes = leaves(tree);
      const open = nodes.find((m) => m.read.editable);
      const blocked = nodes.find(
        (m) =>
          m.read.editable &&
          ['create', 'update', 'delete'].some(
            (op) => m[op].blockedReason === 'OUT_OF_SCOPE',
          ),
      );
      expect(open).toBeDefined();
      expect(blocked).toBeDefined();

      const saved = await call(
        'put',
        `/bp-role-groups/${roleGroupId}/menus`,
        fm1Id,
        {
          updatedAt: tree.updatedAt,
          menus: [cellsOf(open, { read: true })],
        },
      );
      expect(saved.status).toBe(200);

      const op = ['create', 'update', 'delete'].find(
        (o) => blocked[o].blockedReason === 'OUT_OF_SCOPE',
      )!;
      const rejected = await call(
        'put',
        `/bp-role-groups/${roleGroupId}/menus`,
        fm1Id,
        {
          updatedAt: saved.body.updatedAt,
          menus: [cellsOf(blocked, { read: true, [op]: true })],
        },
      );
      expect(rejected.status).toBe(400);

      const preview = await call(
        'post',
        `/bp-role-groups/${roleGroupId}/menus/preview`,
        fm1Id,
        {
          menus: [
            cellsOf(open, {
              read: false,
              create: false,
              update: false,
              delete: false,
            }),
          ],
        },
      );
      expect(preview.status).toBe(200);
      expect(preview.body.affectedRoleGroupCount).toBe(0);
      expect(preview.body.revokedCells).toBeGreaterThan(0);
    });

    it('플랫폼 사용자 · BA 에게는 모든 칸이 READ_ONLY 이고 저장은 403', async () => {
      const tree = (
        await call(
          'get',
          `/bp-role-groups/${baGroupId}/menus?bpCodeId=${bpId}`,
          pmId,
        )
      ).body;
      expect(tree.isSavable).toBe(false);
      expect(
        leaves(tree).every((m) => m.read.blockedReason === 'READ_ONLY'),
      ).toBe(true);
      expect(
        (
          await call('put', `/bp-role-groups/${faGroupId}/menus`, baId, {
            updatedAt: tree.updatedAt,
            menus: [],
          })
        ).status,
      ).toBe(403);
    });

    it('가맹마스터 보기 — FM000001 을 읽기 전용으로, FA 는 403', async () => {
      const res = await call(
        'get',
        '/bp-role-groups/franchise-master/menus',
        bmId,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        roleCode: 'FM000001',
        roleTypeCode: 'FM',
        isSavable: false,
      });
      expect(
        (await call('get', '/bp-role-groups/franchise-master/menus', faId))
          .status,
      ).toBe(403);
    });
  });

  describe('삭제', () => {
    it('대체 후보는 같은 유형 · 같은 관리계정뿐이고, 관리자를 옮긴 뒤 지운다', async () => {
      const target = await create(bmId, `지울 BA ${n}`);
      const replacement = await create(bmId, `대체 BA ${n}`);
      const movedId = await (async () => {
        const { adminAccountId } = await prisma.adminAccount.create({
          data: {
            loginId: `bgmv${n}`,
            name: '옮길 관리자',
            bpCodeId: bpId!,
            passwordHash: '!',
            roleTypeCode: 'BA',
            roleGroupId: target.roleGroupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            isAllStores: true,
            accountStatusCode: 'ACTIVE',
          },
        });
        adminIds.push(adminAccountId);
        return adminAccountId;
      })();

      const candidates = (
        await call(
          'get',
          `/bp-role-groups/${target.roleGroupId}/deletion-candidates`,
          bmId,
        )
      ).body;
      expect(candidates.admins.map((a: any) => a.adminAccountId)).toEqual([
        movedId,
      ]);
      const candidateIds = candidates.candidates.map((c: any) => c.roleGroupId);
      expect(candidateIds).toContain(replacement.roleGroupId);
      expect(candidateIds).not.toContain(target.roleGroupId);
      expect(candidateIds).not.toContain(faGroupId);

      const { updatedAt } = await detailOf(bmId, target.roleGroupId);
      const del = (body: object) =>
        call('delete', `/bp-role-groups/${target.roleGroupId}`, bmId, body);
      expect((await del({ updatedAt })).status).toBe(400);
      expect(
        (await del({ updatedAt, replacementRoleGroupId: faGroupId })).status,
      ).toBe(400);
      expect(
        (
          await del({
            updatedAt,
            replacementRoleGroupId: replacement.roleGroupId,
          })
        ).status,
      ).toBe(204);

      const moved = await prisma.adminAccount.findUniqueOrThrow({
        where: { adminAccountId: movedId },
      });
      expect(moved.roleGroupId).toBe(replacement.roleGroupId);
      expect(
        await prisma.adminChangeHistory.count({
          where: { adminAccountId: movedId, field: '사용자 권한' },
        }),
      ).toBe(1);
      expect(
        (await call('get', `/bp-role-groups/${target.roleGroupId}`, bmId))
          .status,
      ).toBe(404);
    });

    it('FM 은 삭제 메뉴 권한이 없어 403(FM000001 시드)', async () => {
      const { roleGroupId } = await create(fm1Id, `FM 삭제 시험 ${n}`);
      const { updatedAt } = await detailOf(fm1Id, roleGroupId);
      expect(
        (
          await call('delete', `/bp-role-groups/${roleGroupId}`, fm1Id, {
            updatedAt,
          })
        ).status,
      ).toBe(403);
    });
  });
});
