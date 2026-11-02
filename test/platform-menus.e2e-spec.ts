// 응답 본문(supertest 의 any)을 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 플랫폼 메뉴 관리(MN000215)를 실제 DB 로 확인한다. 채번 · 권한 행 · URL 겹침 · 순서 다시 매기기 · 낙관적 잠금과,
// 동시 등록을 advisory lock 이 줄 세우는지는 단위 테스트가 목으로 가정만 하므로 여기서만 증명된다.
describe('플랫폼 메뉴 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 990_000);
  const adminIds: number[] = [];
  const groupIds: number[] = [];
  /** 테스트가 만든 메뉴 — 끝나면 권한 행과 함께 지운다(일회용 DB). */
  const menuIds: number[] = [];

  let platformBpId: number;
  let customerBpId: number | undefined;
  let pmGroupId: number;
  let systemMenuId: number; // MN000212 시스템관리
  let pmId: number;
  let readOnlyId: number;
  let baId: number;
  let customerPmId: number;

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
    ({ roleGroupId: pmGroupId } = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'PM000001' },
    }));
    ({ menuId: systemMenuId } = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000212' },
    }));
    const menuOf = async (menuCode: string) =>
      (await prisma.menu.findFirstOrThrow({ where: { menuCode } })).menuId;

    // 메뉴 관리 조회만 있는 PA 그룹
    const { roleGroupId: readOnlyGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n}`,
        bpCodeId: platformBpId,
        roleTypeCode: 'PA',
        name: `메뉴 조회 ${n}`,
      },
    });
    groupIds.push(readOnlyGroupId);
    await prisma.roleGroupMenu.create({
      data: {
        roleGroupId: readOnlyGroupId,
        menuId: await menuOf('MN000215'),
        isReadable: true,
      },
    });
    // 메뉴 관리 행을 가진 고객 BP 의 BA 그룹 — BP 계정은 행이 있어도 403
    ({ bpCodeId: customerBpId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '메뉴 관리 테스트 BP',
      },
    }));
    const { roleGroupId: baGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n}`,
        bpCodeId: customerBpId,
        roleTypeCode: 'BA',
        name: `BA 메뉴 ${n}`,
      },
    });
    groupIds.push(baGroupId);
    await prisma.roleGroupMenu.create({
      data: {
        roleGroupId: baGroupId,
        menuId: await menuOf('MN000215'),
        isReadable: true,
      },
    });

    const admin = async (
      prefix: string,
      roleTypeCode: string,
      roleGroupId: number,
      bpCodeId = platformBpId,
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
    pmId = await admin('mnpm', 'PM', pmGroupId);
    readOnlyId = await admin('mnro', 'PA', readOnlyGroupId);
    baId = await admin('mnba', 'BA', baGroupId, customerBpId);
    customerPmId = await admin('mncp', 'PM', pmGroupId, customerBpId);
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      // 실패를 기대한 요청이 회귀로 성공해 만든 메뉴도 지운다 — 테스트 관리자가 만든 메뉴를 DB 에서 다시 모은다.
      // 남기면 관리자를 지울 때 created_by 외래키에 걸려 뒤의 정리가 모두 멈춘다.
      const created = adminIds.length
        ? await prisma.menu.findMany({
            where: { createdBy: { in: adminIds } },
            select: { menuId: true },
          })
        : [];
      const toDelete = [
        ...new Set([...menuIds, ...created.map((m) => m.menuId)]),
      ];
      if (toDelete.length) {
        await prisma.roleGroupMenu.deleteMany({
          where: { menuId: { in: toDelete } },
        });
        // 하위부터 지운다(상위 외래키가 RESTRICT). 옮기기로 하위가 바뀌었을 수 있어, 하위가 없는 것부터 반복한다.
        let left = toDelete;
        while (left.length) {
          const leaves: number[] = [];
          for (const id of left)
            if (!(await prisma.menu.count({ where: { parentMenuId: id } })))
              leaves.push(id);
          // 테스트 밖 메뉴가 하위로 남으면 더 지울 것이 없다 — 끝없이 돌지 말고 남은 것을 알린다.
          if (!leaves.length)
            throw new Error(
              `하위가 남아 지우지 못한 테스트 메뉴: ${left.join(', ')}`,
            );
          await prisma.menu.deleteMany({ where: { menuId: { in: leaves } } });
          left = left.filter((id) => !leaves.includes(id));
        }
      }
      if (adminIds.length) {
        // 수정이 시드 메뉴에 updated_by 를 남겼을 수 있다 — 관리자를 지우기 전에 비운다.
        await prisma.menu.updateMany({
          where: { updatedBy: { in: adminIds } },
          data: { updatedBy: null },
        });
        await prisma.adminSession.deleteMany({
          where: { adminAccountId: { in: adminIds } },
        });
        await prisma.adminAccount.deleteMany({
          where: { adminAccountId: { in: adminIds } },
        });
      }
      if (groupIds.length) {
        await prisma.roleGroupMenu.deleteMany({
          where: { roleGroupId: { in: groupIds } },
        });
        await prisma.roleGroup.deleteMany({
          where: { roleGroupId: { in: groupIds } },
        });
      }
      if (customerBpId !== undefined)
        await prisma.bpCode.deleteMany({ where: { bpCodeId: customerBpId } });
    } finally {
      // 정리가 실패해도 앱을 닫는다 — 닫지 않으면 jest 가 끝나지 않는다.
      await app?.close();
    }
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
    method: 'get' | 'put' | 'post',
    path: string,
    sub: number,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return body === undefined ? req : req.send(body);
  };
  const create = async (body: object) => {
    const res = await call('post', '/platform-menus', pmId, body);
    expect(res.status).toBe(201);
    menuIds.push(res.body.menuId);
    return res.body as { menuId: number; menuCode: string };
  };
  const childrenOf = async (parentMenuId: number | null) =>
    prisma.menu.findMany({
      where: { serviceCode: 'PLATFORM', parentMenuId, isDeleted: false },
      orderBy: [{ sortOrder: 'asc' }, { menuId: 'asc' }],
      select: { menuId: true, sortOrder: true, depth: true },
    });

  describe('호출자 확인', () => {
    it('토큰이 없으면 401', async () => {
      await request(app.getHttpServer())
        .get('/platform-menus/services')
        .expect(401);
    });

    it.each([
      ['메뉴 행이 있어도 BP 계정(BA)', () => baId],
      ['고객 BP 소속 PM', () => customerPmId],
    ])('%s 는 403', async (_, who) => {
      expect(
        (await call('get', '/platform-menus/services', who())).status,
      ).toBe(403);
    });

    it('조회만 있으면 읽기는 되고 등록 · 옮기기는 403', async () => {
      expect(
        (await call('get', '/platform-menus?serviceCode=PLATFORM', readOnlyId))
          .status,
      ).toBe(200);
      expect(
        (
          await call('post', '/platform-menus', readOnlyId, {
            serviceCode: 'PLATFORM',
            name: 'x',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            'post',
            `/platform-menus/${systemMenuId}/move`,
            readOnlyId,
            { parentMenuId: null, index: 0 },
          )
        ).status,
      ).toBe(403);
    });
  });

  describe('조회', () => {
    it('서비스 탭은 공통코드 SERVICE 전부와 메뉴 수를 준다', async () => {
      const res = await call('get', '/platform-menus/services', pmId);
      expect(res.status).toBe(200);
      const platform = res.body.items.find(
        (s: { serviceCode: string }) => s.serviceCode === 'PLATFORM',
      );
      expect(platform.menuCount).toBe(
        platform.activeMenuCount + platform.inactiveMenuCount,
      );
      expect(platform.menuCount).toBeGreaterThan(0);
      expect(
        res.body.items.some(
          (s: { serviceCode: string }) => s.serviceCode === 'POS',
        ),
      ).toBe(true);
    });

    it('트리 · 상세 — 메뉴 관리(MN000215)는 시스템관리 아래에 있다', async () => {
      const tree = await call(
        'get',
        '/platform-menus?serviceCode=PLATFORM',
        pmId,
      );
      expect(tree.status).toBe(200);
      const system = tree.body.items.find(
        (m: { menuCode: string }) => m.menuCode === 'MN000212',
      );
      expect(system.isGroup).toBe(true);
      const menusNode = system.children.find(
        (m: { menuCode: string }) => m.menuCode === 'MN000215',
      );
      expect(menusNode).toMatchObject({
        depth: 2,
        url: '/platform-menus',
      });

      const detail = await call(
        'get',
        `/platform-menus/${menusNode.menuId}`,
        pmId,
      );
      expect(detail.body).toMatchObject({
        menuCode: 'MN000215',
        parent: { menuCode: 'MN000212' },
        path: ['시스템관리', '플랫폼 메뉴 관리'],
        isHidden: false,
      });
      expect(
        (await call('get', '/platform-menus?serviceCode=NOPE', pmId)).status,
      ).toBe(404);
      expect((await call('get', '/platform-menus', pmId)).status).toBe(400);
    });
  });

  describe('등록 · 수정', () => {
    it('전체 최대 코드의 다음으로 채번해 상위의 맨 끝에 붙이고, 플랫폼 마스터 권한 행을 넣는다', async () => {
      const last = await prisma.menu.findFirstOrThrow({
        orderBy: { menuCode: 'desc' },
      });
      const before = await childrenOf(systemMenuId);
      const created = await create({
        serviceCode: 'PLATFORM',
        parentMenuId: systemMenuId,
        name: `등록 ${n}`,
        url: `/e2e-${n}`,
      });
      expect(created.menuCode).toBe(
        `MN${String(Number(last.menuCode.slice(2)) + 1).padStart(6, '0')}`,
      );
      const row = await prisma.menu.findUniqueOrThrow({
        where: { menuId: created.menuId },
      });
      expect(row).toMatchObject({
        parentMenuId: systemMenuId,
        depth: 2,
        status: 'ACTIVE',
        sortOrder: Math.max(...before.map((m) => m.sortOrder)) + 1,
      });
      const pmRow = await prisma.roleGroupMenu.findUniqueOrThrow({
        where: {
          roleGroupId_menuId: {
            roleGroupId: pmGroupId,
            menuId: created.menuId,
          },
        },
      });
      expect(pmRow).toMatchObject({
        isReadable: true,
        isCreatable: true,
        isUpdatable: true,
        isDeletable: true,
      });
    });

    it('사용 중 메뉴와 URL 이 같거나 겹치면 409, 미사용이면 받는다', async () => {
      const url = `/e2e-dup-${n}`;
      await create({ serviceCode: 'PLATFORM', name: `사용 ${n}`, url });
      const clash = await call('post', '/platform-menus', pmId, {
        serviceCode: 'PLATFORM',
        name: '겹침',
        url,
      });
      expect(clash.status).toBe(409);
      expect(clash.body.message).toContain('겹치는 URL');
      const { menuId } = await create({
        serviceCode: 'PLATFORM',
        name: `미사용 겹침 ${n}`,
        url,
        status: 'INACTIVE',
      });
      // 메뉴 URL 은 API 권한 키다 — 사용으로 켜면 한 URL 을 두 메뉴가 다투게 되므로 막는다.
      const { updatedAt } = (
        await call('get', `/platform-menus/${menuId}`, pmId)
      ).body;
      const activate = await call('put', `/platform-menus/${menuId}`, pmId, {
        name: `미사용 겹침 ${n}`,
        url,
        status: 'ACTIVE',
        updatedAt,
      });
      expect(activate.status).toBe(409);
      expect(activate.body.message).toContain('겹치는 URL');
      expect(
        await prisma.menu.findUniqueOrThrow({ where: { menuId } }),
      ).toMatchObject({ status: 'INACTIVE' });
    });

    // API 경로에 묶인 메뉴 URL 은 고정이다 — 바꾸면 그 API 가 모두에게 403(잠김), 다른 메뉴가 가져가면 그 API 가
    // 그 메뉴의 권한으로 열린다(권한 상승). 수집한 API 권한 주소(DiscoveryService)가 실제 앱에서 채워지는지도 여기서 본다.
    describe('API 권한 주소', () => {
      it('플랫폼 관리자 관리(MN000213)의 URL 은 바꾸지 못한다 — 값은 그대로', async () => {
        const menu = await prisma.menu.findFirstOrThrow({
          where: { menuCode: 'MN000213' },
        });
        const { updatedAt } = (
          await call('get', `/platform-menus/${menu.menuId}`, pmId)
        ).body;
        const res = await call('put', `/platform-menus/${menu.menuId}`, pmId, {
          name: menu.name,
          url: `/e2e-moved-${n}`,
          status: 'ACTIVE',
          updatedAt,
        });
        expect(res.status).toBe(409);
        expect(res.body.message).toBe(
          'API 권한에 쓰이는 메뉴 주소라 바꿀 수 없습니다(/platform-admins).',
        );
        expect(
          await prisma.menu.findUniqueOrThrow({
            where: { menuId: menu.menuId },
          }),
        ).toMatchObject({
          url: '/platform-admins',
          status: 'ACTIVE',
          updatedAt: menu.updatedAt,
        });
      });

      it('다른 메뉴가 /platform-admins 를 가져가면 409 — 미사용으로 만들어도', async () => {
        const taken = await call('post', '/platform-menus', pmId, {
          serviceCode: 'PLATFORM',
          name: `가져가기 ${n}`,
          url: '/platform-admins',
          status: 'INACTIVE',
        });
        expect(taken.status).toBe(409);
        expect(taken.body.message).toBe(
          '다른 메뉴가 API 권한 주소를 가져갈 수 없습니다(/platform-admins).',
        );

        const { menuId } = await create({
          serviceCode: 'PLATFORM',
          name: `옮기기 ${n}`,
          url: `/e2e-take-${n}`,
        });
        const { updatedAt } = (
          await call('get', `/platform-menus/${menuId}`, pmId)
        ).body;
        const res = await call('put', `/platform-menus/${menuId}`, pmId, {
          name: `옮기기 ${n}`,
          url: '/platform-admins',
          status: 'INACTIVE',
          updatedAt,
        });
        expect(res.status).toBe(409);
        expect(res.body.message).toBe(
          '다른 메뉴가 API 권한 주소를 가져갈 수 없습니다(/platform-admins).',
        );
        expect(
          await prisma.menu.findUniqueOrThrow({ where: { menuId } }),
        ).toMatchObject({ url: `/e2e-take-${n}`, status: 'ACTIVE' });
      });
    });

    it('3단계 메뉴 아래에는 만들지 못한다', async () => {
      const level2 = await create({
        serviceCode: 'PLATFORM',
        parentMenuId: systemMenuId,
        name: `2단계 ${n}`,
      });
      const level3 = await create({
        serviceCode: 'PLATFORM',
        parentMenuId: level2.menuId,
        name: `3단계 ${n}`,
      });
      const res = await call('post', '/platform-menus', pmId, {
        serviceCode: 'PLATFORM',
        parentMenuId: level3.menuId,
        name: '4단계',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('메뉴는 최대 3단계까지만 둘 수 있습니다.');
    });

    it('수정은 updatedAt 이 맞을 때만 — 옛 값으로 다시 저장하면 409, URL 을 빼면 비운다', async () => {
      const { menuId } = await create({
        serviceCode: 'PLATFORM',
        name: `수정 ${n}`,
        url: `/e2e-edit-${n}`,
      });
      const { updatedAt } = (
        await call('get', `/platform-menus/${menuId}`, pmId)
      ).body;
      const ok = await call('put', `/platform-menus/${menuId}`, pmId, {
        name: `수정됨 ${n}`,
        status: 'INACTIVE',
        updatedAt,
      });
      expect(ok.status).toBe(204);
      const again = await call('put', `/platform-menus/${menuId}`, pmId, {
        name: `다시 ${n}`,
        status: 'ACTIVE',
        updatedAt,
      });
      expect(again.status).toBe(409);
      expect(
        await prisma.menu.findUniqueOrThrow({ where: { menuId } }),
      ).toMatchObject({
        name: `수정됨 ${n}`,
        url: null,
        status: 'INACTIVE',
      });
    });

    it('수정으로는 상위 · 서비스를 바꾸지 못한다 — 모르는 칸은 400', async () => {
      const { menuId } = await create({
        serviceCode: 'PLATFORM',
        name: `칸 ${n}`,
      });
      const { updatedAt } = (
        await call('get', `/platform-menus/${menuId}`, pmId)
      ).body;
      const res = await call('put', `/platform-menus/${menuId}`, pmId, {
        name: `칸 ${n}`,
        status: 'ACTIVE',
        updatedAt,
        parentMenuId: systemMenuId,
      });
      expect(res.status).toBe(400);
    });

    // 진짜 병렬 연결이 필요하다. PGlite 소켓 서버는 연결을 백엔드 하나에 섞어 동시 질의가 프로토콜 오류(500)가 되므로,
    // PGlite 로 돌릴 때는 E2E_SINGLE_BACKEND=1 을 주어 건너뛴다(건너뜀으로 보인다). 실제 PostgreSQL 에서는 반드시 돈다.
    (process.env.E2E_SINGLE_BACKEND ? it.skip : it)(
      '동시 등록은 잠금으로 줄 선다 — 코드 · 순서가 겹치지 않고, 같은 URL 은 한 건만 들어간다',
      async () => {
        const parent = await create({
          serviceCode: 'PLATFORM',
          name: `동시 ${n}`,
        });
        // 토큰은 한 번만 — 세션을 새로 발급하면 같은 관리자의 앞 세션이 끊겨 401 이 된다.
        const token = await tokenOf(pmId);
        const send = (i: number, url?: string) =>
          request(app.getHttpServer())
            .post('/platform-menus')
            .set('Authorization', `Bearer ${token}`)
            .send({
              serviceCode: 'PLATFORM',
              parentMenuId: parent.menuId,
              name: `동시 ${i}`,
              ...(url ? { url } : {}),
            });
        const results = await Promise.all([1, 2, 3, 4].map((i) => send(i)));
        for (const r of results) if (r.body.menuId) menuIds.push(r.body.menuId);
        expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
        expect(new Set(results.map((r) => String(r.body.menuCode))).size).toBe(
          4,
        );
        const children = await childrenOf(parent.menuId);
        expect(children.map((m) => m.sortOrder)).toEqual([1, 2, 3, 4]);

        const url = `/e2e-race-${n}`;
        const raced = await Promise.all([5, 6, 7].map((i) => send(i, url)));
        for (const r of raced) if (r.body.menuId) menuIds.push(r.body.menuId);
        expect(raced.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      },
    );
  });

  describe('옮기기', () => {
    it('하위와 함께 다른 상위 맨 앞으로 — 옛 · 새 형제 순서를 1부터 다시 매기고 단계를 다시 센다', async () => {
      const parent = await create({
        serviceCode: 'PLATFORM',
        name: `옮길 묶음 ${n}`,
      });
      const child = await create({
        serviceCode: 'PLATFORM',
        parentMenuId: parent.menuId,
        name: `하위 ${n}`,
      });
      // 순서만 밀릴 형제(시드 메뉴) — 옮긴 뒤에도 수정 버전 · 수정자가 그대로여야 열어 둔 상세가 409 를 받지 않는다.
      const [shifted] = await childrenOf(systemMenuId);
      const shiftedBefore = await prisma.menu.findUniqueOrThrow({
        where: { menuId: shifted.menuId },
      });
      const parentBefore = await prisma.menu.findUniqueOrThrow({
        where: { menuId: parent.menuId },
      });
      const res = await call(
        'post',
        `/platform-menus/${parent.menuId}/move`,
        pmId,
        {
          parentMenuId: systemMenuId,
          index: 0,
        },
      );
      expect(res.status).toBe(204);
      const siblings = await childrenOf(systemMenuId);
      expect(siblings[0]).toMatchObject({
        menuId: parent.menuId,
        sortOrder: 1,
        depth: 2,
      });
      expect(siblings.map((m) => m.sortOrder)).toEqual(
        siblings.map((_, i) => i + 1),
      );
      const shiftedAfter = await prisma.menu.findUniqueOrThrow({
        where: { menuId: shifted.menuId },
      });
      expect(shiftedAfter.sortOrder).toBe(2);
      expect(shiftedAfter.updatedAt).toEqual(shiftedBefore.updatedAt);
      expect(shiftedAfter.updatedBy).toBe(shiftedBefore.updatedBy);
      // 옮기기 전에 연 상세의 updatedAt 그대로 저장된다 — 옮긴 메뉴 자신도 버전이 오르지 않는다.
      expect(
        (
          await call('put', `/platform-menus/${parent.menuId}`, pmId, {
            name: parentBefore.name,
            status: 'ACTIVE',
            updatedAt: parentBefore.updatedAt.toISOString(),
          })
        ).status,
      ).toBe(204);
      expect(
        await prisma.menu.findUniqueOrThrow({
          where: { menuId: child.menuId },
        }),
      ).toMatchObject({
        depth: 3,
      });
      const roots = await childrenOf(null);
      expect(roots.map((m) => m.sortOrder)).toEqual(roots.map((_, i) => i + 1));

      // 자기 하위 아래로 · 3단계를 넘게 · 다른 서비스로는 400
      for (const [target, message] of [
        [
          child.menuId,
          '메뉴를 자기 자신이나 하위 메뉴 아래로 옮길 수 없습니다.',
        ],
        [siblings[1].menuId, '메뉴는 최대 3단계까지만 둘 수 있습니다.'],
        [
          (
            await prisma.menu.findFirstOrThrow({
              where: { serviceCode: 'WHALE_ERP' },
            })
          ).menuId,
          '같은 서비스 안에서만 옮길 수 있습니다.',
        ],
      ] as const) {
        const bad = await call(
          'post',
          `/platform-menus/${parent.menuId}/move`,
          pmId,
          {
            parentMenuId: target,
            index: 0,
          },
        );
        expect(bad.status).toBe(400);
        expect(bad.body.message).toBe(message);
      }

      // 최상위로 되돌린다
      expect(
        (
          await call('post', `/platform-menus/${parent.menuId}/move`, pmId, {
            parentMenuId: null,
            index: 99,
          })
        ).status,
      ).toBe(204);
      expect(
        await prisma.menu.findUniqueOrThrow({
          where: { menuId: child.menuId },
        }),
      ).toMatchObject({
        depth: 2,
      });
      const after = await childrenOf(systemMenuId);
      expect(after.map((m) => m.sortOrder)).toEqual(after.map((_, i) => i + 1));
    });
  });
});
