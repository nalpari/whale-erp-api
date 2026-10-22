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
  /** 플랫폼 BP 의 PA 로, MN000216 의 조회 · 등록만 있고 수정은 없다. */
  let createOnlyAdminId: number;
  let createOnlyRoleGroupId: number;
  const adminIds = () => [
    platformAdminId,
    deletedPlatformAdminId,
    bpAdminId,
    noMenuPlatformAdminId,
    customerPmId,
    passwordChangePendingId,
    updateOnlyAdminId,
    createOnlyAdminId,
  ];
  const roleGroupIds = () =>
    [noMenuRoleGroupId, updateOnlyRoleGroupId, createOnlyRoleGroupId].filter(
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
    // 조회 · 등록만 있는 권한 그룹. 권한 코드가 겹치지 않게 n + 2.
    ({ roleGroupId: createOnlyRoleGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n + 2}`,
        bpCodeId: platformBp.bpCodeId,
        roleTypeCode: 'PA',
        name: `공통코드 e2e 등록만 ${n}`,
      },
    }));
    await prisma.roleGroupMenu.create({
      data: {
        roleGroupId: createOnlyRoleGroupId,
        menuId: codeMenu.menuId,
        isReadable: true,
        isCreatable: true,
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
    ({ adminAccountId: createOnlyAdminId } = await admin(`cgcre${n}`, 'PA', {
      roleGroupId: createOnlyRoleGroupId,
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
    method: 'get' | 'put' | 'post' | 'delete',
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

  // 등록은 POST { items }, 수정은 PUT { items } — 둘 다 본문 없이 204.
  const createGroups = (groups: object[], sub?: number) =>
    call('post', '/code-groups', { items: groups }, sub);
  const updateGroups = (groups: object[], sub?: number) =>
    call('put', '/code-groups', { items: groups }, sub);
  const itemsPathOf = (groupCode: string) => `/code-groups/${groupCode}/items`;

  describe('그룹 목록 검색', () => {
    it('그룹 코드(대소문자 무시) · 그룹명 부분 일치로 찾는다', async () => {
      const groupCode = code('SRCH');
      const res = await createGroups([
        { ...newGroup(groupCode), groupName: `검색 대상 ${n}` },
      ]);
      expect(res.status).toBe(204);

      const byCode = await call(
        'get',
        `/code-groups?groupCode=${encodeURIComponent(`e2e${n}_srch`)}`,
      );
      expect(byCode.status).toBe(200);
      expect(byCode.body).toMatchObject({
        items: [{ groupCode }],
        total: 1,
      });

      const byName = await call(
        'get',
        `/code-groups?groupName=${encodeURIComponent(`검색 대상 ${n}`)}`,
      );
      expect(byName.body).toMatchObject({ items: [{ groupCode }], total: 1 });
    });

    // 와일드카드를 그대로 넘기면 `%` 가 아무 글자와 맞아 두 그룹이 다 나온다.
    it('검색어의 % 는 글자 그대로 찾는다', async () => {
      const percent = code('PCT');
      const plain = code('PLN');
      const res = await createGroups([
        { ...newGroup(percent), groupName: `백분율 ${n}%` },
        { ...newGroup(plain), groupName: `백분율 ${n}x` },
      ]);
      expect(res.status).toBe(204);

      const found = await call(
        'get',
        `/code-groups?groupName=${encodeURIComponent(`${n}%`)}`,
      );
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        items: [{ groupCode: percent }],
        total: 1,
      });
    });
  });

  describe('그룹 등록 · 수정', () => {
    it('소문자로 보낸 새 그룹 코드는 대문자로 저장된다', async () => {
      const groupCode = code('LOWER');
      const res = await createGroups([
        { ...newGroup(groupCode), groupCode: groupCode.toLowerCase() },
      ]);

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({
        isBpApplied: false,
        createdBy: platformAdminId,
      });
    });

    it('수정은 그룹명 · 사용 상태 · 표시 순서를 고친다', async () => {
      const groupCode = code('EDIT');
      await createGroups([newGroup(groupCode)]);

      const res = await updateGroups([
        { groupCode, groupName: '고친 이름', status: 'INACTIVE', sortOrder: 7 },
      ]);

      expect(res.status).toBe(204);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({
        groupName: '고친 이름',
        status: 'INACTIVE',
        sortOrder: 7,
        manageOwnerCode: 'PLATFORM_PROVIDED',
      });
    });

    it('수정 중 하나라도 없는 그룹이면 404 이고 아무것도 고치지 않는다', async () => {
      const groupCode = code('PART');
      await createGroups([newGroup(groupCode)]);

      const res = await updateGroups([
        { groupCode, groupName: '고친 이름', status: 'ACTIVE', sortOrder: 1 },
        {
          groupCode: code('NONE'),
          groupName: '없는 그룹',
          status: 'ACTIVE',
          sortOrder: 2,
        },
      ]);

      expect(res.status).toBe(404);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({ groupName: '테스트 그룹' });
    });

    it('수정 요청으로 관리 주체를 바꾸려 하면 400', async () => {
      const groupCode = code('OWNER');
      await createGroups([newGroup(groupCode)]);

      const res = await updateGroups([
        {
          groupCode,
          groupName: '이름',
          status: 'ACTIVE',
          sortOrder: 1,
          manageOwnerCode: 'PLATFORM_FIXED',
        },
      ]);
      expect(res.status).toBe(400);
    });

    it('수정 요청 안에 같은 그룹 코드가 두 번 있으면 409 이고 아무것도 고치지 않는다', async () => {
      const groupCode = code('TWICE');
      await createGroups([newGroup(groupCode)]);

      const res = await updateGroups([
        { groupCode, groupName: '첫째', status: 'INACTIVE', sortOrder: 5 },
        { groupCode, groupName: '둘째', status: 'INACTIVE', sortOrder: 6 },
      ]);

      expect(res.status).toBe(409);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({
        groupName: '테스트 그룹',
        status: 'ACTIVE',
        sortOrder: 1,
      });
    });

    it('이미 있는 그룹 코드를 등록하면 409', async () => {
      const groupCode = code('DUP');
      await createGroups([newGroup(groupCode)]);

      expect((await createGroups([newGroup(groupCode)])).status).toBe(409);
    });

    it.each(['post', 'put'] as const)(
      '%s 의 items 가 비면 400',
      async (method) => {
        expect((await call(method, '/code-groups', { items: [] })).status).toBe(
          400,
        );
      },
    );

    it('표시 순서가 integer 범위를 넘으면 500 이 아니라 400', async () => {
      const res = await createGroups([
        { ...newGroup(code('BIG')), sortOrder: 2_147_483_648 },
      ]);
      expect(res.status).toBe(400);
    });

    it('두 관리자가 같은 그룹 코드를 동시에 만들면 하나는 204, 하나는 409 — 500 은 없다', async () => {
      const groups = [newGroup(code('RACE'))];

      const statuses = (
        await Promise.all([createGroups(groups), createGroups(groups)])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([204, 409]);
    });
  });

  // 등록(POST)은 MN000216 create, 수정(PUT)은 update 를 가드가 경로마다 본다.
  describe('등록 · 수정 권한', () => {
    const updateOf = (groupCode: string) => ({
      groupCode,
      groupName: '수정만 있는 관리자가 고친 이름',
      status: 'ACTIVE',
      sortOrder: 2,
    });

    it('수정 권한만 있는 플랫폼 관리자가 그룹을 등록하면 403 이고 그 그룹은 생기지 않는다', async () => {
      const created = code('NOCREATE');

      const res = await createGroups([newGroup(created)], updateOnlyAdminId);

      expect(res.status).toBe(403);
      expect((res.body as { message?: unknown }).message).toBe(
        ACCESS_DENIED_MESSAGE,
      );
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode: created } }),
      ).resolves.toBeNull();
    });

    it('수정 권한만 있는 플랫폼 관리자도 그룹 수정은 204', async () => {
      const existing = code('UPD');
      await createGroups([newGroup(existing)]);

      const res = await updateGroups([updateOf(existing)], updateOnlyAdminId);

      expect(res.status).toBe(204);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode: existing } }),
      ).resolves.toMatchObject({
        groupName: '수정만 있는 관리자가 고친 이름',
        updatedBy: updateOnlyAdminId,
      });
    });

    it('상세 코드도 같다 — 수정 권한만이면 등록은 403 으로 아무것도 생기지 않고, 수정은 204', async () => {
      const groupCode = code('ITEMS');
      await createGroups([newGroup(groupCode)]);
      const itemsPath = itemsPathOf(groupCode);
      await call('post', itemsPath, { items: [item('KEEP')] });
      const platformRows = () =>
        prisma.codeItem.findMany({
          where: { groupCode, bpCode: 'BP000000' },
          select: { itemCode: true, label: true },
          orderBy: { itemCode: 'asc' },
        });

      const denied = await call(
        'post',
        itemsPath,
        { items: [item('NEW', 2)] },
        updateOnlyAdminId,
      );
      expect(denied.status).toBe(403);
      expect((denied.body as { message?: unknown }).message).toBe(
        ACCESS_DENIED_MESSAGE,
      );
      await expect(platformRows()).resolves.toEqual([
        { itemCode: 'KEEP', label: '코드 KEEP' },
      ]);

      const allowed = await call(
        'put',
        itemsPath,
        { items: [{ ...item('KEEP'), label: '수정만으로 고친 코드' }] },
        updateOnlyAdminId,
      );
      expect(allowed.status).toBe(204);
      await expect(platformRows()).resolves.toEqual([
        { itemCode: 'KEEP', label: '수정만으로 고친 코드' },
      ]);
    });

    it('삭제 권한이 없으면 상세 코드 삭제는 403 이고 행이 그대로다', async () => {
      const groupCode = code('NODEL');
      await createGroups([newGroup(groupCode)]);
      await call('post', itemsPathOf(groupCode), { items: [item('KEEP')] });

      const denied = await call(
        'delete',
        itemsPathOf(groupCode),
        { itemCodes: ['KEEP'] },
        updateOnlyAdminId,
      );
      expect(denied.status).toBe(403);
      await expect(
        prisma.codeItem.findMany({
          where: { groupCode, bpCode: 'BP000000' },
          select: { itemCode: true, isDeleted: true },
        }),
      ).resolves.toEqual([{ itemCode: 'KEEP', isDeleted: false }]);
    });

    it('등록 권한만 있는 플랫폼 관리자는 그룹 등록이 204, 수정은 403 이고 값이 그대로다', async () => {
      const groupCode = code('CREONLY');

      const created = await createGroups(
        [newGroup(groupCode)],
        createOnlyAdminId,
      );
      expect(created.status).toBe(204);

      const denied = await updateGroups(
        [updateOf(groupCode)],
        createOnlyAdminId,
      );
      expect(denied.status).toBe(403);
      expect((denied.body as { message?: unknown }).message).toBe(
        ACCESS_DENIED_MESSAGE,
      );
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({
        groupName: '테스트 그룹',
        sortOrder: 1,
        createdBy: createOnlyAdminId,
        updatedBy: createOnlyAdminId,
      });
    });

    it('등록 권한까지 있는 플랫폼 관리자는 그룹 · 상세 코드 등록이 204', async () => {
      const groupCode = code('CREATOR');

      expect((await createGroups([newGroup(groupCode)])).status).toBe(204);
      expect(
        (
          await call('post', itemsPathOf(groupCode), {
            items: [item('FIRST')],
          })
        ).status,
      ).toBe(204);
      await expect(
        prisma.codeItem.findMany({
          where: { groupCode },
          select: { itemCode: true, bpCode: true, createdBy: true },
        }),
      ).resolves.toEqual([
        { itemCode: 'FIRST', bpCode: 'BP000000', createdBy: platformAdminId },
      ]);
    });
  });

  describe('상세 코드 · BP 적용', () => {
    let groupCode: string;
    const itemsPath = () => itemsPathOf(groupCode);
    const applyPath = () => `/code-groups/${groupCode}/bp-application`;

    beforeEach(async () => {
      groupCode = code(String(randomInt(1000, 9999)));
      await createGroups([newGroup(groupCode)]);
    });

    it('상세 코드 수정에 이 그룹에 없는 코드가 섞이면 404 이고 아무것도 고치지 않는다', async () => {
      await call('post', itemsPath(), { items: [item('FULL')] });

      const res = await call('put', itemsPath(), {
        items: [{ ...item('FULL'), label: '고친 이름' }, item('NONE', 2)],
      });

      expect(res.status).toBe(404);
      await expect(
        prisma.codeItem.findMany({
          where: { groupCode },
          select: { itemCode: true, label: true },
        }),
      ).resolves.toEqual([{ itemCode: 'FULL', label: '코드 FULL' }]);
    });

    // 플랫폼고정 코드는 시스템이 값으로 참조한다(SERVICE 를 메뉴가) — 지우면 메뉴 관리가 500 이 된다.
    it('플랫폼고정 그룹의 상세 코드는 지우지 못한다 — 409, 행이 그대로다', async () => {
      const fixedGroup = code('FIXDEL');
      await createGroups([
        { ...newGroup(fixedGroup), manageOwnerCode: 'PLATFORM_FIXED' },
      ]);
      await call('post', itemsPathOf(fixedGroup), { items: [item('KEEP')] });

      const res = await call('delete', itemsPathOf(fixedGroup), {
        itemCodes: ['KEEP'],
      });
      expect(res.status).toBe(409);
      await expect(
        prisma.codeItem.findMany({
          where: { groupCode: fixedGroup },
          select: { itemCode: true, isDeleted: true },
        }),
      ).resolves.toEqual([{ itemCode: 'KEEP', isDeleted: false }]);
    });

    it('상세 코드 삭제는 플랫폼 원본만 논리 삭제한다 — BP 에 복사된 행은 남는다', async () => {
      await call('post', itemsPath(), {
        items: [item('FULL'), item('PART', 2)],
      });
      expect((await call('post', applyPath())).status).toBe(200);

      const res = await call('delete', itemsPath(), { itemCodes: ['full'] });
      expect(res.status).toBe(204);

      const rows = await prisma.codeItem.findMany({
        where: {
          groupCode,
          itemCode: 'FULL',
          bpCode: { in: ['BP000000', bpCode] },
        },
        select: { bpCode: true, isDeleted: true },
      });
      expect(rows).toEqual(
        expect.arrayContaining([
          { bpCode: 'BP000000', isDeleted: true },
          { bpCode, isDeleted: false },
        ]),
      );
      // 화면 목록에서 빠지고, 다시 지우면 404. BP 에 살아 있는 복사본이 있어 같은 코드로 다시 만들면 409.
      const list = await call('get', itemsPath());
      expect(
        (list.body as { items: { itemCode: string }[] }).items.map(
          (i) => i.itemCode,
        ),
      ).toEqual(['PART']);
      expect(
        (await call('delete', itemsPath(), { itemCodes: ['FULL'] })).status,
      ).toBe(404);
      // FULL 은 원본을 지웠어도 BP 에 살아 있는 행이 있어 「이미 있는」 문구다.
      const again = await call('post', itemsPath(), { items: [item('FULL')] });
      expect(again.status).toBe(409);
      expect((again.body as { message: string }).message).toBe(
        '이 그룹에 이미 있는 상세 코드입니다: FULL',
      );
    });

    it('지운 원본과 같은 코드로 등록하면 그 원본을 요청 값으로 되살린다', async () => {
      await call('post', itemsPath(), { items: [item('GONE')] });
      expect(
        (await call('delete', itemsPath(), { itemCodes: ['GONE'] })).status,
      ).toBe(204);

      const again = await call('post', itemsPath(), {
        items: [{ ...item('GONE', 5), label: '되살린 이름' }],
      });
      expect(again.status).toBe(204);
      await expect(
        prisma.codeItem.findMany({
          where: { groupCode, itemCode: 'GONE' },
          select: {
            bpCode: true,
            isDeleted: true,
            label: true,
            sortOrder: true,
          },
        }),
      ).resolves.toEqual([
        {
          bpCode: 'BP000000',
          isDeleted: false,
          label: '되살린 이름',
          sortOrder: 5,
        },
      ]);
    });

    it('상세 코드 삭제에 이 그룹에 없는 코드가 섞이면 404 이고 아무것도 지우지 않는다', async () => {
      await call('post', itemsPath(), { items: [item('FULL')] });

      const res = await call('delete', itemsPath(), {
        itemCodes: ['FULL', 'NONE'],
      });

      expect(res.status).toBe(404);
      await expect(
        prisma.codeItem.findMany({
          where: { groupCode },
          select: { itemCode: true, isDeleted: true },
        }),
      ).resolves.toEqual([{ itemCode: 'FULL', isDeleted: false }]);
    });

    it.each(['post', 'put'] as const)(
      '%s 의 items 가 비면 400',
      async (method) => {
        expect((await call(method, itemsPath(), { items: [] })).status).toBe(
          400,
        );
      },
    );

    it('두 관리자가 같은 상세 코드를 동시에 만들면 하나는 204, 하나는 409', async () => {
      const body = { items: [item('SAME')] };

      const statuses = (
        await Promise.all([
          call('post', itemsPath(), body),
          call('post', itemsPath(), body),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([204, 409]);
    });

    it('두 관리자가 같은 상세 코드를 동시에 지우면 한 번만 지우고 나머지는 404 · 409 — 500 이 아니다', async () => {
      const groupCode = code('RACEDEL');
      await createGroups([newGroup(groupCode)]);
      await call('post', itemsPathOf(groupCode), { items: [item('GONE')] });
      const body = { itemCodes: ['GONE'] };

      const statuses = (
        await Promise.all([
          call('delete', itemsPathOf(groupCode), body),
          call('delete', itemsPathOf(groupCode), body),
        ])
      ).map((r) => r.status);
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      expect(statuses.every((s) => [204, 404, 409].includes(s))).toBe(true);
      await expect(
        prisma.codeItem.findMany({
          where: { groupCode, itemCode: 'GONE' },
          select: { isDeleted: true },
        }),
      ).resolves.toEqual([{ isDeleted: true }]);
    });

    it('상세 코드가 없으면 적용은 409 이고 적용으로 표시되지 않는다', async () => {
      expect((await call('post', applyPath())).status).toBe(409);
      await expect(
        prisma.codeGroup.findUnique({ where: { groupCode } }),
      ).resolves.toMatchObject({ isBpApplied: false });
    });

    it('BP 에 없는 행만 넣는다 — 다시 적용해도 BP 가 고친 행은 그대로, 그 뒤 추가한 코드만 들어간다', async () => {
      await call('post', itemsPath(), {
        items: [item('FULL', 1), item('PART', 2)],
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
      await call('post', itemsPath(), { items: [item('TEMP', 3)] });
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
