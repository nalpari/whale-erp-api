import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
} from '../src/auth/access-messages';
import { PrismaService } from '../src/prisma/prisma.service';

// 플랫폼 공통코드 관리를 실제 DB 로 확인한다. 동시에 같은 코드를 만들 때의 409, BP 적용이 있는 행을
// 건너뛰는 것(ON CONFLICT DO NOTHING)은 단위 테스트가 목의 반환값으로 가정만 하므로 여기서만 증명된다.
describe('플랫폼 공통코드 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  /** 이 실행만의 그룹 코드. 그룹 코드는 전역 PK 이고 지운 코드도 다시 쓰지 않으므로 매번 새로 짓는다. */
  const code = (suffix: string) => `E2E${n}_${suffix}`;
  const groupCodes: string[] = [];

  let bpCodeId: number;
  let bpCode: string;
  let platformAdminId: number;
  let deletedPlatformAdminId: number;
  let bpAdminId: number;
  /** 플랫폼 BP 의 PA 지만 권한 그룹에 MN000216 이 없다. */
  let noMenuPlatformAdminId: number;
  /** PM000001 권한 그룹(MN000216 전부 허용)을 가졌지만 고객 BP 소속인 PM. */
  let customerPmId: number;
  /** 강제 비밀번호 변경을 마치지 않은 플랫폼 관리자. */
  let passwordChangePendingId: number;
  let noMenuRoleGroupId: number;
  /** 플랫폼 BP 의 PA 로, MN000216 의 조회 · 수정만 있고 등록은 없다. */
  let updateOnlyAdminId: number;
  let updateOnlyRoleGroupId: number;
  const adminIds = () => [
    platformAdminId,
    deletedPlatformAdminId,
    bpAdminId,
    noMenuPlatformAdminId,
    customerPmId,
    passwordChangePendingId,
    updateOnlyAdminId,
  ];
  const roleGroupIds = () =>
    [noMenuRoleGroupId, updateOnlyRoleGroupId].filter(
      (id): id is number => id !== undefined,
    );

  beforeAll(async () => {
    // BP 적용은 DB 의 사용 중인 고객 BP 전부에 행을 넣는다. 공용 개발 DB 에서 돌면 남의 BP 에 쓰므로
    // 일회용 DB 를 명시해야만 돈다.
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    // 동시 요청 시험이 있다. 띄워 두지 않으면 supertest 가 요청마다 같은 서버를 열다 ECONNREFUSED 가 난다.
    await app.listen(0);
    prisma = app.get(PrismaService);

    bpCode = `BP${n}`;
    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '공통코드 테스트 BP',
      },
    }));
    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const pmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'PM000001' },
    });
    const bmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    // 메뉴가 하나도 없는 플랫폼 관리자 권한 그룹. 권한 코드는 유형코드 + 6자리.
    ({ roleGroupId: noMenuRoleGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n}`,
        bpCodeId: platformBp.bpCodeId,
        roleTypeCode: 'PA',
        name: `공통코드 e2e 메뉴 없음 ${n}`,
      },
    }));
    // 공통코드 관리(MN000216)의 조회 · 수정만 있는 플랫폼 관리자 권한 그룹. 권한 코드가 겹치지 않게 n + 1.
    ({ roleGroupId: updateOnlyRoleGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n + 1}`,
        bpCodeId: platformBp.bpCodeId,
        roleTypeCode: 'PA',
        name: `공통코드 e2e 수정만 ${n}`,
      },
    }));
    const codeMenu = await prisma.menu.findFirstOrThrow({
      where: { menuCode: 'MN000216' },
    });
    await prisma.roleGroupMenu.create({
      data: {
        roleGroupId: updateOnlyRoleGroupId,
        menuId: codeMenu.menuId,
        isReadable: true,
        isUpdatable: true,
      },
    });
    const admin = (
      loginId: string,
      roleTypeCode: string,
      extra: {
        isDeleted?: boolean;
        isPasswordChangeRequired?: boolean;
        bpCodeId?: number;
        roleGroupId?: number;
      } = {},
    ) =>
      prisma.adminAccount.create({
        data: {
          loginId,
          bpCodeId: roleTypeCode === 'PA' ? platformBp.bpCodeId : bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId:
            roleTypeCode === 'PA' || roleTypeCode === 'PM'
              ? pmGroup.roleGroupId
              : bmGroup.roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
          ...extra,
        },
      });
    ({ adminAccountId: platformAdminId } = await admin(`cgpa${n}`, 'PA'));
    ({ adminAccountId: deletedPlatformAdminId } = await admin(
      `cgdel${n}`,
      'PA',
      { isDeleted: true },
    ));
    ({ adminAccountId: bpAdminId } = await admin(`cgba${n}`, 'BA'));
    ({ adminAccountId: noMenuPlatformAdminId } = await admin(
      `cgnomenu${n}`,
      'PA',
      { roleGroupId: noMenuRoleGroupId },
    ));
    // bpCodeId 를 따로 주지 않으면 PA 가 아닌 유형은 고객 BP 에 붙는다.
    ({ adminAccountId: customerPmId } = await admin(`cgcpm${n}`, 'PM'));
    ({ adminAccountId: passwordChangePendingId } = await admin(
      `cgpwd${n}`,
      'PA',
      { isPasswordChangeRequired: true },
    ));
    ({ adminAccountId: updateOnlyAdminId } = await admin(`cgupd${n}`, 'PA', {
      roleGroupId: updateOnlyRoleGroupId,
    }));
  });

  afterAll(async () => {
    if (!prisma) return;
    // 외래키 순서: 상세 코드 → 그룹 → 관리자 → BP.
    // beforeAll 이 중간에 실패하면 id 가 비어 있다. Prisma 는 where 의 undefined 를 조건 없음으로 읽어
    // 표 전체를 지우려 하므로, 정해진 id 만 지운다.
    await prisma.codeItem.deleteMany({
      where: { groupCode: { in: groupCodes } },
    });
    await prisma.codeGroup.deleteMany({
      where: { groupCode: { in: groupCodes } },
    });
    const ids = adminIds().filter((id): id is number => id !== undefined);
    if (ids.length) {
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: { in: ids } },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: { in: ids } },
      });
    }
    if (roleGroupIds().length) {
      await prisma.roleGroupMenu.deleteMany({
        where: { roleGroupId: { in: roleGroupIds() } },
      });
      await prisma.roleGroup.deleteMany({
        where: { roleGroupId: { in: roleGroupIds() } },
      });
    }
    if (bpCodeId !== undefined)
      await prisma.bpCode.deleteMany({ where: { bpCodeId } });
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
    method: 'get' | 'put' | 'post',
    path: string,
    body?: object,
    sub = platformAdminId,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return body === undefined ? req : req.send(body);
  };
  const newGroup = (groupCode: string) => {
    groupCodes.push(groupCode);
    return {
      groupCode,
      groupName: '테스트 그룹',
      manageOwnerCode: 'PLATFORM_PROVIDED',
      status: 'ACTIVE',
      sortOrder: 1,
    };
  };
  const item = (itemCode: string, sortOrder = 1) => ({
    itemCode,
    label: `코드 ${itemCode}`,
    status: 'ACTIVE',
    sortOrder,
  });

  describe('권한', () => {
    it('토큰이 없으면 401', async () => {
      const res = await request(app.getHttpServer()).get('/code-groups');
      expect(res.status).toBe(401);
    });

    const messageOf = (res: { body: { message?: unknown } }) =>
      res.body.message;

    it('BP 관리자는 403', async () => {
      const res = await call('get', '/code-groups', undefined, bpAdminId);
      expect(res.status).toBe(403);
      expect(messageOf(res)).toBe(ACCESS_DENIED_MESSAGE);
    });

    it('지운 플랫폼 관리자는 토큰이 살아 있어도 쓸 수 없는 계정으로 403', async () => {
      const res = await call(
        'get',
        '/code-groups',
        undefined,
        deletedPlatformAdminId,
      );
      expect(res.status).toBe(403);
      expect(messageOf(res)).toBe(ACCOUNT_UNAVAILABLE_MESSAGE);
    });

    it('메뉴 권한(MN000216)이 없는 플랫폼 계정은 403', async () => {
      const res = await call(
        'get',
        '/code-groups',
        undefined,
        noMenuPlatformAdminId,
      );
      expect(res.status).toBe(403);
      expect(messageOf(res)).toBe(ACCESS_DENIED_MESSAGE);
    });

    it('메뉴 권한이 있어도 고객 BP 소속의 PM 은 403', async () => {
      const res = await call('get', '/code-groups', undefined, customerPmId);
      expect(res.status).toBe(403);
      expect(messageOf(res)).toBe(ACCESS_DENIED_MESSAGE);
    });

    it('강제 비밀번호 변경을 마치기 전에는 403', async () => {
      const res = await call(
        'get',
        '/code-groups',
        undefined,
        passwordChangePendingId,
      );
      expect(res.status).toBe(403);
      expect(messageOf(res)).toBe(PASSWORD_CHANGE_REQUIRED_MESSAGE);
    });
  });

  describe('그룹 저장', () => {
    it('소문자로 보낸 새 그룹 코드는 대문자로 저장된다', async () => {
      const groupCode = code('LOWER');
      const res = await call('put', '/code-groups', {
        updates: [],
        creates: [
          { ...newGroup(groupCode), groupCode: groupCode.toLowerCase() },
        ],
      });

      expect(res.status).toBe(204);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({
        isBpApplied: false,
        createdBy: platformAdminId,
      });
    });

    it('수정 요청으로 관리 주체를 바꾸려 하면 400', async () => {
      const groupCode = code('OWNER');
      await call('put', '/code-groups', {
        updates: [],
        creates: [newGroup(groupCode)],
      });

      const res = await call('put', '/code-groups', {
        updates: [
          {
            groupCode,
            groupName: '이름',
            status: 'ACTIVE',
            sortOrder: 1,
            manageOwnerCode: 'PLATFORM_FIXED',
          },
        ],
        creates: [],
      });
      expect(res.status).toBe(400);
    });

    it('표시 순서가 integer 범위를 넘으면 500 이 아니라 400', async () => {
      const res = await call('put', '/code-groups', {
        updates: [],
        creates: [{ ...newGroup(code('BIG')), sortOrder: 2_147_483_648 }],
      });
      expect(res.status).toBe(400);
    });

    it('두 관리자가 같은 그룹 코드를 동시에 만들면 하나는 204, 하나는 409 — 500 은 없다', async () => {
      const body = { updates: [], creates: [newGroup(code('RACE'))] };

      const statuses = (
        await Promise.all([
          call('put', '/code-groups', body),
          call('put', '/code-groups', body),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([204, 409]);
    });
  });

  // 패널 저장은 가드가 수정(update)을 보고, 본문에 새 행(creates)이 있을 때만 핸들러가 등록(create)을 더 본다.
  describe('새 행이 섞인 저장의 등록 권한', () => {
    const updateOf = (groupCode: string) => ({
      groupCode,
      groupName: '수정만 있는 관리자가 고친 이름',
      status: 'ACTIVE',
      sortOrder: 2,
    });

    it('수정 권한만 있는 플랫폼 관리자가 그룹 저장에 새 그룹을 섞으면 403 이고 그 그룹은 생기지 않는다', async () => {
      const existing = code('UPD');
      await call('put', '/code-groups', {
        updates: [],
        creates: [newGroup(existing)],
      });
      const created = code('NOCREATE');

      const res = await call(
        'put',
        '/code-groups',
        { updates: [updateOf(existing)], creates: [newGroup(created)] },
        updateOnlyAdminId,
      );

      expect(res.status).toBe(403);
      expect((res.body as { message?: unknown }).message).toBe(
        ACCESS_DENIED_MESSAGE,
      );
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode: created } }),
      ).resolves.toBeNull();
      // 같이 보낸 수정도 반영되지 않는다 — 판정이 저장보다 먼저다.
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode: existing } }),
      ).resolves.toMatchObject({ groupName: '테스트 그룹' });
    });

    it('수정 권한만 있는 플랫폼 관리자도 새 그룹 없이(creates: []) 수정만 보내면 204', async () => {
      const existing = code('UPD2');
      await call('put', '/code-groups', {
        updates: [],
        creates: [newGroup(existing)],
      });

      const res = await call(
        'put',
        '/code-groups',
        { updates: [updateOf(existing)], creates: [] },
        updateOnlyAdminId,
      );

      expect(res.status).toBe(204);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode: existing } }),
      ).resolves.toMatchObject({
        groupName: '수정만 있는 관리자가 고친 이름',
        updatedBy: updateOnlyAdminId,
      });
    });

    it('상세 코드 저장도 같다 — 새 코드를 섞으면 403 으로 아무것도 생기지 않고, 수정만이면 204', async () => {
      const groupCode = code('ITEMS');
      await call('put', '/code-groups', {
        updates: [],
        creates: [newGroup(groupCode)],
      });
      const itemsPath = `/code-groups/${groupCode}/items`;
      await call('put', itemsPath, { updates: [], creates: [item('KEEP')] });
      const renamed = { ...item('KEEP'), label: '수정만으로 고친 코드' };

      const denied = await call(
        'put',
        itemsPath,
        { updates: [renamed], creates: [item('NEW', 2)] },
        updateOnlyAdminId,
      );
      expect(denied.status).toBe(403);
      expect((denied.body as { message?: unknown }).message).toBe(
        ACCESS_DENIED_MESSAGE,
      );
      const platformRows = () =>
        prisma.codeItem.findMany({
          where: { groupCode, bpCode: 'BP000000' },
          select: { itemCode: true, label: true },
          orderBy: { itemCode: 'asc' },
        });
      await expect(platformRows()).resolves.toEqual([
        { itemCode: 'KEEP', label: '코드 KEEP' },
      ]);

      const allowed = await call(
        'put',
        itemsPath,
        { updates: [renamed], creates: [] },
        updateOnlyAdminId,
      );
      expect(allowed.status).toBe(204);
      await expect(platformRows()).resolves.toEqual([
        { itemCode: 'KEEP', label: '수정만으로 고친 코드' },
      ]);
    });
  });

  describe('상세 코드 · BP 적용', () => {
    let groupCode: string;
    const itemsPath = () => `/code-groups/${groupCode}/items`;
    const applyPath = () => `/code-groups/${groupCode}/bp-application`;

    beforeEach(async () => {
      groupCode = code(String(randomInt(1000, 9999)));
      await call('put', '/code-groups', {
        updates: [],
        creates: [newGroup(groupCode)],
      });
    });

    it('두 관리자가 같은 상세 코드를 동시에 만들면 하나는 204, 하나는 409', async () => {
      const body = { updates: [], creates: [item('SAME')] };

      const statuses = (
        await Promise.all([
          call('put', itemsPath(), body),
          call('put', itemsPath(), body),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([204, 409]);
    });

    it('상세 코드가 없으면 적용은 409 이고 적용으로 표시되지 않는다', async () => {
      expect((await call('post', applyPath())).status).toBe(409);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({ isBpApplied: false });
    });

    it('BP 에 없는 행만 넣는다 — 다시 적용해도 BP 가 고친 행은 그대로, 그 뒤 추가한 코드만 들어간다', async () => {
      await call('put', itemsPath(), {
        updates: [],
        creates: [item('FULL', 1), item('PART', 2)],
      });
      const first = await call('post', applyPath());
      expect(first.status).toBe(200);
      const bpRows = () =>
        prisma.codeItem.findMany({
          where: { groupCode, bpCode },
          select: { itemCode: true, label: true },
          orderBy: { itemCode: 'asc' },
        });
      await expect(bpRows()).resolves.toEqual([
        { itemCode: 'FULL', label: '코드 FULL' },
        { itemCode: 'PART', label: '코드 PART' },
      ]);

      // BP 가 자기 행을 고치고, 플랫폼은 원본에 코드를 하나 더한다.
      await prisma.codeItem.update({
        where: {
          groupCode_itemCode_bpCode: { groupCode, itemCode: 'FULL', bpCode },
        },
        data: { label: 'BP 가 고친 이름' },
      });
      await call('put', itemsPath(), {
        updates: [],
        creates: [item('TEMP', 3)],
      });
      expect((await call('post', applyPath())).status).toBe(200);

      await expect(bpRows()).resolves.toEqual([
        { itemCode: 'FULL', label: 'BP 가 고친 이름' },
        { itemCode: 'PART', label: '코드 PART' },
        { itemCode: 'TEMP', label: '코드 TEMP' },
      ]);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({ isBpApplied: true });
    });
  });
});
