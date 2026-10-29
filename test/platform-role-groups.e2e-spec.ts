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

// 플랫폼 권한 관리(MN000214)를 실제 DB 로 확인한다. 권한 저장이 다음 요청의 판정을 바꾸는 것, BP 마스터 회수가
// BA 그룹의 칸까지 끄는 것, 삭제의 관리자 이관은 단위 테스트가 목으로 가정만 하므로 여기서만 증명된다.
describe('플랫폼 권한 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  // PA${n + 1} 과 그 뒤 등록 코드가 6자리 · 999999 안에 들도록 넉넉히 아래에서 고른다.
  const n = randomInt(100_000, 990_000);
  const adminIds: number[] = [];
  /** 테스트가 만든 권한 그룹(API 로 만든 PA 추가 권한 포함). 끝나면 지운다. */
  const groupIds: number[] = [];

  let customerBpId: number | undefined;
  let platformBpId: number;
  let pmGroupId: number;
  let paGroupId: number;
  let bmGroupId: number;
  let menuIdOf: Record<string, number>;
  /**
   * 테스트가 바꾸는 고정 권한(BM000001)의 행 — 끝나면 isDeletable · updatedBy 만 되돌린다. updated_at 과, 다른 BP 의
   * BA 그룹에 연쇄로 꺼진 칸은 되돌리지 않는다(일회용 DB 라서).
   */
  let bmOriginal:
    | {
        menu: { isDeletable: boolean; updatedBy: number | null };
        group: { updatedBy: number | null };
      }
    | undefined;

  let pmId: number;
  let paId: number;
  let noMenuId: number;
  let baId: number;
  let customerPmId: number;
  let pendingId: number;
  let baGroupId: number;
  /** 지운 BA 그룹 — 회수 연쇄가 건드리지 않아야 한다. */
  let deletedBaGroupId: number;
  let noMenuGroupId: number;

  beforeAll(async () => {
    // BP 마스터 회수는 모든 BP 의 BA 그룹을 고친다. 공용 DB 에서 돌면 남의 그룹을 바꾼다. 여기서는 APP_ENV=test 와
    // DATABASE_URL 이 있는지만 본다 — 그 URL 이 일회용 DB 인지는 돌리는 사람이 지킨다.
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
    bmGroupId = await fixed('BM000001');
    const menus = await prisma.menu.findMany({
      where: {
        menuCode: { in: ['MN000010', 'MN000212', 'MN000213', 'MN000214'] },
      },
      select: { menuId: true, menuCode: true },
    });
    menuIdOf = Object.fromEntries(menus.map((m) => [m.menuCode, m.menuId]));

    const bmRow = await prisma.roleGroupMenu.findUniqueOrThrow({
      where: {
        roleGroupId_menuId: {
          roleGroupId: bmGroupId,
          menuId: menuIdOf.MN000010,
        },
      },
    });
    const bmGroup = await prisma.roleGroup.findUniqueOrThrow({
      where: { roleGroupId: bmGroupId },
    });
    bmOriginal = {
      menu: { isDeletable: bmRow.isDeletable, updatedBy: bmRow.updatedBy },
      group: { updatedBy: bmGroup.updatedBy },
    };

    ({ bpCodeId: customerBpId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '권한 관리 테스트 BP',
      },
    }));
    // BA 그룹 — BP 마스터 회수가 함께 끄는지 본다. 권한 관리 메뉴 행도 줘서 「BP 계정은 메뉴 행이 있어도 403」을 본다.
    ({ roleGroupId: baGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n}`,
        bpCodeId: customerBpId,
        roleTypeCode: 'BA',
        name: `BA 테스트 ${n}`,
      },
    }));
    groupIds.push(baGroupId);
    await prisma.roleGroupMenu.createMany({
      data: [
        {
          roleGroupId: baGroupId,
          menuId: menuIdOf.MN000010,
          isReadable: true,
          isCreatable: true,
          isUpdatable: true,
          isDeletable: true,
        },
        {
          roleGroupId: baGroupId,
          menuId: menuIdOf.MN000214,
          isReadable: true,
        },
      ],
    });
    ({ roleGroupId: deletedBaGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n + 1}`,
        bpCodeId: customerBpId,
        roleTypeCode: 'BA',
        name: `지운 BA ${n}`,
        isDeleted: true,
      },
    }));
    groupIds.push(deletedBaGroupId);
    await prisma.roleGroupMenu.create({
      data: {
        roleGroupId: deletedBaGroupId,
        menuId: menuIdOf.MN000010,
        isReadable: true,
        isCreatable: true,
        isUpdatable: true,
        isDeletable: true,
      },
    });
    // 권한 관리 메뉴 행이 없는 PA 그룹
    ({ roleGroupId: noMenuGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n}`,
        bpCodeId: platformBpId,
        roleTypeCode: 'PA',
        name: `메뉴 없음 ${n}`,
      },
    }));
    groupIds.push(noMenuGroupId);
    // PA 호출자의 그룹 — 시드된 PA 권한이 없어 직접 만든다. 권한 관리는 등록 · 수정까지, 관리자 관리는 삭제가 없다.
    ({ roleGroupId: paGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n + 1}`,
        bpCodeId: platformBpId,
        roleTypeCode: 'PA',
        name: `PA 호출자 ${n}`,
      },
    }));
    groupIds.push(paGroupId);
    await prisma.roleGroupMenu.createMany({
      data: [
        { roleGroupId: paGroupId, menuId: menuIdOf.MN000212, isReadable: true },
        ...['MN000213', 'MN000214'].map((code) => ({
          roleGroupId: paGroupId,
          menuId: menuIdOf[code],
          isReadable: true,
          isCreatable: true,
          isUpdatable: true,
        })),
      ],
    });

    const admin = async (
      prefix: string,
      roleTypeCode: string,
      roleGroupId: number,
      extra: { bpCodeId?: number; isPasswordChangeRequired?: boolean } = {},
    ) => {
      const { adminAccountId } = await prisma.adminAccount.create({
        data: {
          loginId: `${prefix}${n}`,
          name: `시험${prefix}`,
          bpCodeId: platformBpId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
          ...extra,
        },
      });
      adminIds.push(adminAccountId);
      return adminAccountId;
    };
    pmId = await admin('rgpm', 'PM', pmGroupId);
    paId = await admin('rgpa', 'PA', paGroupId);
    noMenuId = await admin('rgnm', 'PA', noMenuGroupId);
    baId = await admin('rgba', 'BA', baGroupId, { bpCodeId: customerBpId });
    customerPmId = await admin('rgcp', 'PM', pmGroupId, {
      bpCodeId: customerBpId,
    });
    pendingId = await admin('rgpc', 'PM', pmGroupId, {
      isPasswordChangeRequired: true,
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    // 준비가 중간에 실패했으면 만든 것만 지운다 — 아무것도 안 만들었으면 아무것도 지우지 않는다.
    if (bmOriginal) {
      await prisma.roleGroupMenu.update({
        where: {
          roleGroupId_menuId: {
            roleGroupId: bmGroupId,
            menuId: menuIdOf.MN000010,
          },
        },
        data: {
          isDeletable: bmOriginal.menu.isDeletable,
          updatedBy: bmOriginal.menu.updatedBy,
        },
      });
      await prisma.roleGroup.update({
        where: { roleGroupId: bmGroupId },
        data: { updatedBy: bmOriginal.group.updatedBy },
      });
    }
    if (adminIds.length || groupIds.length) {
      await prisma.adminChangeHistory.deleteMany({
        where: {
          OR: [
            { adminAccountId: { in: adminIds } },
            { changedBy: { in: adminIds } },
          ],
        },
      });
      await prisma.roleGroupMenu.deleteMany({
        where: { roleGroupId: { in: groupIds } },
      });
      // 관리자 ↔ 권한 그룹이 서로를 가리킨다(role_group_id · created_by). 관리자를 고정 권한으로 옮긴 뒤 그룹을 지운다.
      await prisma.adminAccount.updateMany({
        where: { adminAccountId: { in: adminIds } },
        data: { roleGroupId: pmGroupId, updatedBy: null, createdBy: null },
      });
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: { in: adminIds } },
      });
      await prisma.roleGroup.deleteMany({
        where: { roleGroupId: { in: groupIds } },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: { in: adminIds } },
      });
    }
    if (customerBpId !== undefined)
      await prisma.bpCode.deleteMany({ where: { bpCodeId: customerBpId } });
    await app.close();
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
  const updatedAtOf = async (id: number) =>
    (await call('get', `/platform-role-groups/${id}`, pmId)).body
      .updatedAt as string;
  const create = async (name: string) => {
    const res = await call('post', '/platform-role-groups', pmId, { name });
    expect(res.status).toBe(201);
    groupIds.push(res.body.roleGroupId);
    return res.body as { roleGroupId: number; roleCode: string };
  };
  const cells = (
    menuCode: string,
    r: boolean,
    c = false,
    u = false,
    d = false,
  ) => ({
    menuId: menuIdOf[menuCode],
    read: r,
    create: c,
    update: u,
    delete: d,
  });

  describe('호출자 확인', () => {
    it('토큰이 없으면 401', async () => {
      await request(app.getHttpServer())
        .get('/platform-role-groups')
        .expect(401);
    });

    it.each([
      ['권한 관리 메뉴 권한이 없는 PA', () => noMenuId],
      ['메뉴 행이 있어도 BP 계정(BA)', () => baId],
      ['고객 BP 소속 PM', () => customerPmId],
    ])('%s 는 공용 문구로 403', async (_, who) => {
      const res = await call('get', '/platform-role-groups', who());
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(
        '접근 권한이 없습니다. 관리자에게 문의해 주세요.',
      );
    });

    it('강제 비밀번호 변경 전이면 403', async () => {
      const res = await call('get', '/platform-role-groups', pendingId);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(
        '서비스 이용을 위해 비밀번호를 변경해 주세요.',
      );
    });
  });

  describe('목록 · 등록 · 수정', () => {
    it('고정 권한이 PM · BM · FM 순으로 먼저 오고 BA 는 없다', async () => {
      const res = await call('get', '/platform-role-groups', paId);
      expect(res.status).toBe(200);
      const codes = res.body.items.map((i: { roleCode: string }) => i.roleCode);
      expect(codes.slice(0, 3)).toEqual(['PM000001', 'BM000001', 'FM000001']);
      expect(codes).not.toContain(`BA${n}`);
      expect(res.body.total).toBe(codes.length);
    });

    it('등록하면 지운 것까지 포함한 마지막 PA 코드의 다음을 받는다', async () => {
      const last = await prisma.roleGroup.findFirstOrThrow({
        where: { roleCode: { startsWith: 'PA' } },
        orderBy: { roleCode: 'desc' },
      });
      const created = await create(`등록 ${n}`);
      expect(created.roleCode).toBe(
        `PA${String(Number(last.roleCode.slice(2)) + 1).padStart(6, '0')}`,
      );
      const row = await prisma.roleGroup.findUniqueOrThrow({
        where: { roleGroupId: created.roleGroupId },
      });
      expect(row).toMatchObject({ isMaster: false, roleTypeCode: 'PA' });
    });

    it('플랫폼 권한 안에서 같은 이름이면 409', async () => {
      const res = await call('post', '/platform-role-groups', pmId, {
        name: 'BP 마스터',
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('같은 이름의 권한이 있습니다.');
    });

    it('수정은 updatedAt 이 맞을 때만 — 옛 값으로 다시 저장하면 409', async () => {
      const { roleGroupId } = await create(`수정 ${n}`);
      const updatedAt = await updatedAtOf(roleGroupId);
      await call('put', `/platform-role-groups/${roleGroupId}`, pmId, {
        name: `수정됨 ${n}`,
        description: '설명',
        updatedAt,
      }).then((r) => expect(r.status).toBe(204));
      const again = await call(
        'put',
        `/platform-role-groups/${roleGroupId}`,
        pmId,
        { name: `다시 ${n}`, updatedAt },
      );
      expect(again.status).toBe(409);
      const detail = await call(
        'get',
        `/platform-role-groups/${roleGroupId}`,
        pmId,
      );
      expect(detail.body).toMatchObject({
        name: `수정됨 ${n}`,
        description: '설명',
        isEditable: true,
        isDeletable: true,
      });
    });

    it('본인이 연결된 권한은 403, 플랫폼 마스터 메뉴 저장은 409', async () => {
      const self = await call(
        'put',
        `/platform-role-groups/${paGroupId}`,
        paId,
        {
          name: '플랫폼 관리자',
          updatedAt: await updatedAtOf(paGroupId),
        },
      );
      expect(self.status).toBe(403);
      const pmMenus = await call(
        'put',
        `/platform-role-groups/${pmGroupId}/menus`,
        paId,
        { menus: [], updatedAt: await updatedAtOf(pmGroupId) },
      );
      expect(pmMenus.status).toBe(409);
    });
  });

  describe('메뉴 권한', () => {
    it('저장하면 그 그룹 관리자의 다음 요청부터 판정이 바뀐다', async () => {
      const { roleGroupId } = await create(`판정 ${n}`);
      const memberId = await (async () => {
        const { adminAccountId } = await prisma.adminAccount.create({
          data: {
            loginId: `rgmb${n}`,
            name: '시험회원',
            bpCodeId: platformBpId,
            passwordHash: '!',
            roleTypeCode: 'PA',
            roleGroupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            accountStatusCode: 'ACTIVE',
          },
        });
        adminIds.push(adminAccountId);
        return adminAccountId;
      })();
      expect((await call('get', '/platform-admins', memberId)).status).toBe(
        403,
      );

      const on = await call(
        'put',
        `/platform-role-groups/${roleGroupId}/menus`,
        pmId,
        {
          menus: [cells('MN000213', true)],
          updatedAt: await updatedAtOf(roleGroupId),
        },
      );
      expect(on.status).toBe(200);
      expect((await call('get', '/platform-admins', memberId)).status).toBe(
        200,
      );

      // 묶음 메뉴(시스템관리)는 하위를 따라 조회만 켜졌다.
      const tree = await call(
        'get',
        `/platform-role-groups/${roleGroupId}/menus`,
        pmId,
      );
      const platform = tree.body.services.find(
        (s: { serviceCode: string }) => s.serviceCode === 'PLATFORM',
      );
      const system = platform.menus.find(
        (m: { menuCode: string }) => m.menuCode === 'MN000212',
      );
      expect(system.isGroup).toBe(true);
      expect(system.read.value).toBe(true);
      expect(
        system.children.find(
          (m: { menuCode: string }) => m.menuCode === 'MN000213',
        ).read.value,
      ).toBe(true);

      const off = await call(
        'put',
        `/platform-role-groups/${roleGroupId}/menus`,
        pmId,
        { menus: [cells('MN000213', false)], updatedAt: on.body.updatedAt },
      );
      expect(off.status).toBe(200);
      expect((await call('get', '/platform-admins', memberId)).status).toBe(
        403,
      );

      // 모두 꺼도 행은 남고 네 칸이 false 다.
      const row = await prisma.roleGroupMenu.findUniqueOrThrow({
        where: {
          roleGroupId_menuId: { roleGroupId, menuId: menuIdOf.MN000213 },
        },
      });
      expect(row).toMatchObject({ isReadable: false, isDeleted: false });
    });

    it('PA 호출자는 본인 권한 범위 밖 칸을 줄 수 없다(400)', async () => {
      const { roleGroupId } = await create(`상한 ${n}`);
      const res = await call(
        'put',
        `/platform-role-groups/${roleGroupId}/menus`,
        paId,
        {
          // PA 호출자 그룹은 플랫폼 관리자 관리 삭제 권한이 없다.
          menus: [cells('MN000213', true, false, false, true)],
          updatedAt: await updatedAtOf(roleGroupId),
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('본인 권한 범위 밖 칸은 바꿀 수 없습니다.');
    });

    it('BP 마스터에서 칸을 회수하면 미리보기가 범위를 세고, 저장하면 BA 그룹의 같은 칸도 꺼진다', async () => {
      const body = [cells('MN000010', true, true, true, false)];
      // 연쇄가 바꿀 BA 그룹 — 지우지 않은 BA 그룹 중 그 칸이 켜진 것(이 테스트 밖의 그룹이 있어도 맞게 센다).
      const hitGroups = (
        await prisma.roleGroupMenu.findMany({
          where: {
            menuId: menuIdOf.MN000010,
            isDeleted: false,
            isDeletable: true,
            roleGroup: { isDeleted: false, roleTypeCode: 'BA' },
          },
          select: { roleGroupId: true },
        })
      ).map((r) => r.roleGroupId);
      expect(hitGroups).toContain(baGroupId);
      expect(hitGroups).not.toContain(deletedBaGroupId);
      const expectedAdmins = await prisma.adminAccount.count({
        where: {
          isDeleted: false,
          roleGroupId: { in: [...hitGroups, bmGroupId] },
        },
      });

      const preview = await call(
        'post',
        `/platform-role-groups/${bmGroupId}/menus/preview`,
        pmId,
        { menus: body },
      );
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({
        revokedCells: 1,
        affectedRoleGroupCount: hitGroups.length,
        affectedAdminCount: expectedAdmins,
      });

      const saved = await call(
        'put',
        `/platform-role-groups/${bmGroupId}/menus`,
        pmId,
        { menus: body, updatedAt: await updatedAtOf(bmGroupId) },
      );
      expect(saved.status).toBe(200);
      const baRow = await prisma.roleGroupMenu.findUniqueOrThrow({
        where: {
          roleGroupId_menuId: {
            roleGroupId: baGroupId,
            menuId: menuIdOf.MN000010,
          },
        },
      });
      expect(baRow).toMatchObject({
        isReadable: true,
        isCreatable: true,
        isUpdatable: true,
        isDeletable: false,
      });
      // 지운 BA 그룹의 행은 그대로다.
      const deletedRow = await prisma.roleGroupMenu.findUniqueOrThrow({
        where: {
          roleGroupId_menuId: {
            roleGroupId: deletedBaGroupId,
            menuId: menuIdOf.MN000010,
          },
        },
      });
      expect(deletedRow.isDeletable).toBe(true);

      // BP 마스터에는 플랫폼 메뉴를 줄 수 없다.
      const platformMenu = await call(
        'put',
        `/platform-role-groups/${bmGroupId}/menus`,
        pmId,
        { menus: [cells('MN000213', true)], updatedAt: saved.body.updatedAt },
      );
      expect(platformMenu.status).toBe(400);
    });

    it('같은 updatedAt 으로 두 번 저장하면 두 번째는 409 — 첫 저장이 남는다', async () => {
      const { roleGroupId } = await create(`동시 ${n}`);
      const updatedAt = await updatedAtOf(roleGroupId);
      const path = `/platform-role-groups/${roleGroupId}/menus`;
      const first = await call('put', path, pmId, {
        menus: [cells('MN000213', true)],
        updatedAt,
      });
      expect(first.status).toBe(200);
      const second = await call('put', path, pmId, {
        menus: [cells('MN000213', true, true)],
        updatedAt,
      });
      expect(second.status).toBe(409);
      const row = await prisma.roleGroupMenu.findUniqueOrThrow({
        where: {
          roleGroupId_menuId: { roleGroupId, menuId: menuIdOf.MN000213 },
        },
      });
      expect(row).toMatchObject({ isReadable: true, isCreatable: false });
      // 첫 저장이 돌려준 updatedAt 으로는 저장된다.
      const third = await call('put', path, pmId, {
        menus: [cells('MN000213', true, true)],
        updatedAt: first.body.updatedAt,
      });
      expect(third.status).toBe(200);
    });
  });

  describe('삭제', () => {
    it('연결 사용자를 대체 권한으로 옮기고 지운다 — 대체 없음 · 다른 유형은 400', async () => {
      const doomed = await create(`삭제 ${n}`);
      const keep = await create(`대체 ${n}`);
      const { adminAccountId: movedId } = await prisma.adminAccount.create({
        data: {
          loginId: `rgmv${n}`,
          name: '시험이관',
          bpCodeId: platformBpId,
          passwordHash: '!',
          roleTypeCode: 'PA',
          roleGroupId: doomed.roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          accountStatusCode: 'INACTIVE',
        },
      });
      adminIds.push(movedId);

      const candidates = await call(
        'get',
        `/platform-role-groups/${doomed.roleGroupId}/deletion-candidates`,
        pmId,
      );
      expect(candidates.status).toBe(200);
      expect(candidates.body.admins).toEqual([
        expect.objectContaining({
          adminAccountId: movedId,
          accountStatusCode: 'INACTIVE',
        }),
      ]);
      const codes = candidates.body.candidates.map(
        (c: { roleCode: string }) => c.roleCode,
      );
      expect(codes).toContain(keep.roleCode);
      expect(codes).not.toContain('BM000001');
      expect(codes).not.toContain(doomed.roleCode);

      const updatedAt = await updatedAtOf(doomed.roleGroupId);
      const path = `/platform-role-groups/${doomed.roleGroupId}`;
      expect((await call('delete', path, pmId, { updatedAt })).status).toBe(
        400,
      );
      expect(
        (
          await call('delete', path, pmId, {
            updatedAt,
            replacementRoleGroupId: bmGroupId,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('delete', path, pmId, {
            updatedAt,
            replacementRoleGroupId: keep.roleGroupId,
          })
        ).status,
      ).toBe(204);

      const moved = await prisma.adminAccount.findUniqueOrThrow({
        where: { adminAccountId: movedId },
      });
      expect(moved.roleGroupId).toBe(keep.roleGroupId);
      const adminHistory = await prisma.adminChangeHistory.findFirst({
        where: { adminAccountId: movedId, field: '사용자 권한' },
      });
      expect(adminHistory).toMatchObject({
        beforeValue: `삭제 ${n} ${doomed.roleCode}`,
        afterValue: `대체 ${n} ${keep.roleCode}`,
      });
      expect(
        (
          await prisma.roleGroup.findUniqueOrThrow({
            where: { roleGroupId: doomed.roleGroupId },
          })
        ).isDeleted,
      ).toBe(true);
      expect((await call('get', path, pmId)).status).toBe(404);

      // 고정 권한은 지울 수 없다.
      const fixedDelete = await call(
        'delete',
        `/platform-role-groups/${bmGroupId}`,
        pmId,
        { updatedAt: await updatedAtOf(bmGroupId) },
      );
      expect(fixedDelete.status).toBe(409);
    });
  });
});
