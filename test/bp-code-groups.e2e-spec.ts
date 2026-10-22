import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { OTHER_BP_MESSAGE } from '../src/auth/menu-permission.guard';
import { PrismaService } from '../src/prisma/prisma.service';

// BP 공통코드 관리를 실제 DB 로 확인한다. 가드의 경로 메뉴(/bp-code-groups) · X-Bp-Code-Id 판정은 여기서만 증명된다.
// 동시 등록은 「하나만 생기고 나머지는 409」까지만 본다 — 일회용 DB(PGlite)에서는 409 가 확인 단계에서 나는지
// ON CONFLICT 에서 나는지 가리지 못하고, ON CONFLICT 경로는 단위 테스트가 목으로 본다.
//
// describe 는 파일 순서대로 돈다 — 「조회」는 「등록」이 행을 더하기 전의 목록을 기대한다.
describe('BP 공통코드 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  /** 이 실행만의 그룹 코드. 그룹 코드는 전역 PK 라 매번 새로 짓는다. 검색어 `E2E${n}` 로 이 실행의 그룹만 본다. */
  const code = (suffix: string) => `E2E${n}_${suffix}`;
  const applied = code('AP');
  const notApplied = code('NA');
  const fixed = code('FX');
  const stopped = code('ST');
  const deleted = code('DL');
  const groupCodes = [applied, notApplied, fixed, stopped, deleted];

  let bpA: { bpCodeId: number; bpCode: string };
  let bpB: { bpCodeId: number; bpCode: string };
  let platformAdminId: number;
  let bmAId: number;
  let bmBId: number;
  const adminIds = () =>
    [platformAdminId, bmAId, bmBId].filter(
      (id): id is number => id !== undefined,
    );

  beforeAll(async () => {
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

    const bp = (bpCode: string) =>
      prisma.bpCode.create({
        data: {
          bpCode,
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: 'BP 공통코드 테스트',
        },
        select: { bpCodeId: true, bpCode: true },
      });
    bpA = await bp(`BP${n}`);
    // BP 코드는 BP + 6자리라 n + 1 이 7자리가 되지 않게 n 은 999_999 미만이다.
    bpB = await bp(`BP${n + 1}`);

    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const pmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'PM000001' },
    });
    const bmGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    const admin = (
      loginId: string,
      roleTypeCode: string,
      bpCodeId: number,
      roleGroupId: number,
    ) =>
      prisma.adminAccount.create({
        data: {
          loginId,
          bpCodeId,
          passwordHash: '!',
          roleTypeCode,
          roleGroupId,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
      });
    ({ adminAccountId: platformAdminId } = await admin(
      `bcgpa${n}`,
      'PA',
      platformBp.bpCodeId,
      pmGroup.roleGroupId,
    ));
    ({ adminAccountId: bmAId } = await admin(
      `bcgbma${n}`,
      'BM',
      bpA.bpCodeId,
      bmGroup.roleGroupId,
    ));
    ({ adminAccountId: bmBId } = await admin(
      `bcgbmb${n}`,
      'BM',
      bpB.bpCodeId,
      bmGroup.roleGroupId,
    ));

    const group = (
      groupCode: string,
      manageOwnerCode: string,
      extra: { isBpApplied?: boolean; status?: 'ACTIVE' | 'INACTIVE' } = {},
    ) => ({
      groupCode,
      groupName: `BP 공통코드 e2e ${groupCode}`,
      manageOwnerCode,
      isBpApplied: false,
      status: 'ACTIVE' as const,
      sortOrder: 1,
      ...extra,
    });
    await prisma.codeGroup.createMany({
      data: [
        group(applied, 'PLATFORM_PROVIDED', { isBpApplied: true }),
        group(notApplied, 'PLATFORM_PROVIDED'),
        { ...group(deleted, 'PLATFORM_PROVIDED'), isDeleted: true },
        group(fixed, 'PLATFORM_FIXED'),
        group(stopped, 'PLATFORM_PROVIDED', {
          isBpApplied: true,
          status: 'INACTIVE',
        }),
      ],
    });
    const row = (
      groupCode: string,
      bpCode: string,
      itemCode: string,
      manageOwnerCode: string,
      status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
      sortOrder = 1,
    ) => ({
      groupCode,
      bpCode,
      itemCode,
      label: `코드 ${itemCode}`,
      manageOwnerCode,
      status,
      sortOrder,
    });
    await prisma.codeItem.createMany({
      data: [
        // 적용된 플랫폼제공 그룹 — 원본과 BP A 에 복사된 행. CONTRACT 는 플랫폼이 사용 중지했다.
        row(applied, 'BP000000', 'FULL', 'PLATFORM_PROVIDED'),
        row(
          applied,
          'BP000000',
          'CONTRACT',
          'PLATFORM_PROVIDED',
          'INACTIVE',
          2,
        ),
        row(applied, bpA.bpCode, 'FULL', 'PLATFORM_PROVIDED'),
        row(
          applied,
          bpA.bpCode,
          'CONTRACT',
          'PLATFORM_PROVIDED',
          'INACTIVE',
          2,
        ),
        // 적용 뒤 플랫폼이 더한 코드 — BP 에는 오지 않았다.
        row(applied, 'BP000000', 'LATE', 'PLATFORM_PROVIDED', 'ACTIVE', 3),
        row(fixed, 'BP000000', 'ONE', 'PLATFORM_FIXED'),
        row(stopped, 'BP000000', 'ONE', 'PLATFORM_PROVIDED'),
        row(stopped, bpA.bpCode, 'ONE', 'PLATFORM_PROVIDED'),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    // 외래키 순서: 상세 코드 → 그룹 → 관리자 → BP. beforeAll 이 중간에 실패해도 정해진 것만 지운다.
    await prisma.codeItem.deleteMany({
      where: { groupCode: { in: groupCodes } },
    });
    await prisma.codeGroup.deleteMany({
      where: { groupCode: { in: groupCodes } },
    });
    if (adminIds().length) {
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: { in: adminIds() } },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: { in: adminIds() } },
      });
    }
    const bpIds = [bpA, bpB].flatMap((b) => (b ? [b.bpCodeId] : []));
    if (bpIds.length)
      await prisma.bpCode.deleteMany({ where: { bpCodeId: { in: bpIds } } });
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
    {
      sub = bmAId,
      bpCodeId,
      body,
    }: {
      sub?: number;
      bpCodeId?: number;
      body?: object;
    } = {},
  ) => {
    let req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    if (bpCodeId !== undefined) req = req.set('X-Bp-Code-Id', String(bpCodeId));
    return body === undefined ? req : req.send(body);
  };
  const itemsPathOf = (groupCode: string) =>
    `/bp-code-groups/${groupCode}/items`;
  const item = (itemCode: string, extra: Record<string, unknown> = {}) => ({
    itemCode,
    label: `코드 ${itemCode}`,
    status: 'ACTIVE',
    sortOrder: 9,
    ...extra,
  });
  const create = (groupCode: string, items: object[], sub = bmAId) =>
    call('post', itemsPathOf(groupCode), { sub, body: { items } });
  const update = (groupCode: string, items: object[], sub = bmAId) =>
    call('put', itemsPathOf(groupCode), { sub, body: { items } });
  type ListBody = {
    items: Record<string, unknown>[];
    total: number;
    message?: unknown;
  };
  const bodyOf = (res: { body: unknown }) => res.body as ListBody;
  const itemCodesOf = (res: { body: unknown }) =>
    bodyOf(res).items.map((i) => i.itemCode);

  describe('조회', () => {
    it('사용 중인 플랫폼고정 · 플랫폼제공 그룹을 적용 여부와 관계없이 보인다 — 사용중지 · 지운 그룹은 빠진다', async () => {
      const res = await call('get', `/bp-code-groups?groupCode=e2e${n}`);

      expect(res.status).toBe(200);
      expect(
        bodyOf(res)
          .items.map((g) => g.groupCode)
          .sort(),
      ).toEqual([applied, notApplied, fixed].sort());
      expect(bodyOf(res).total).toBe(3);
    });

    it('플랫폼제공 그룹은 그 BP 의 행을 보이고, 플랫폼이 사용 중지한 코드를 표시한다', async () => {
      const res = await call('get', itemsPathOf(applied));

      expect(res.status).toBe(200);
      // 적용 뒤 플랫폼이 더한 LATE 는 오지 않는다.
      expect(itemCodesOf(res)).toEqual(['FULL', 'CONTRACT']);
      expect(bodyOf(res).items[1]).toMatchObject({
        status: 'INACTIVE',
        manageOwnerCode: 'PLATFORM_PROVIDED',
        isPlatformInactive: true,
      });
    });

    it('플랫폼고정 그룹은 복사 없이 플랫폼 원본을 보인다', async () => {
      const res = await call('get', itemsPathOf(fixed), { sub: bmBId });

      expect(res.status).toBe(200);
      expect(itemCodesOf(res)).toEqual(['ONE']);
    });

    it('아직 복사되지 않은 플랫폼제공 그룹은 빈 목록, 지운 그룹은 404', async () => {
      const empty = await call('get', itemsPathOf(notApplied));
      expect(empty.status).toBe(200);
      expect(bodyOf(empty)).toMatchObject({ items: [], total: 0 });

      expect((await call('get', itemsPathOf(deleted))).status).toBe(404);
    });
  });

  describe('대상 BP', () => {
    it('BP 계정이 다른 BP 를 헤더로 보내면 403', async () => {
      const res = await call('get', '/bp-code-groups', {
        bpCodeId: bpB.bpCodeId,
      });
      expect(res.status).toBe(403);
      expect(bodyOf(res).message).toBe(OTHER_BP_MESSAGE);
    });

    it('플랫폼 사용자는 BP 를 골라 조회한다 — 헤더가 없으면 400', async () => {
      const picked = await call('get', itemsPathOf(applied), {
        sub: platformAdminId,
        bpCodeId: bpA.bpCodeId,
      });
      expect(picked.status).toBe(200);
      expect(itemCodesOf(picked)).toEqual(['FULL', 'CONTRACT']);

      const missing = await call('get', '/bp-code-groups', {
        sub: platformAdminId,
      });
      expect(missing.status).toBe(400);
    });

    it('플랫폼 사용자의 등록 · 수정 · 삭제는 메뉴 권한이 있어도 403', async () => {
      const bodies = {
        post: { items: [item('PLAT')] },
        put: { items: [item('PLAT')] },
        delete: { itemCodes: ['PLAT'] },
      };
      for (const method of ['post', 'put', 'delete'] as const) {
        const res = await call(method, itemsPathOf(applied), {
          sub: platformAdminId,
          bpCodeId: bpA.bpCodeId,
          body: bodies[method],
        });
        expect(res.status).toBe(403);
      }
    });

    // 쓰기의 403 은 헤더 누락 400 · 그룹 404 · 409 보다 먼저다 — 판정 순서가 바뀌면 여기서 걸린다.
    it('플랫폼 사용자의 쓰기는 헤더가 없어도 · 쓸 수 없는 그룹이어도 403', async () => {
      const noHeader = await call('post', itemsPathOf(applied), {
        sub: platformAdminId,
        body: { items: [item('PLAT')] },
      });
      expect(noHeader.status).toBe(403);
      for (const groupCode of [fixed, stopped]) {
        const res = await call('delete', itemsPathOf(groupCode), {
          sub: platformAdminId,
          bpCodeId: bpA.bpCodeId,
          body: { itemCodes: ['ONE'] },
        });
        expect(res.status).toBe(403);
      }
    });
  });

  describe('등록', () => {
    it('BP전용 코드로 그 BP 에만 생기고 다른 BP 에는 보이지 않는다', async () => {
      const res = await create(applied, [item('intern')]);
      expect(res.status).toBe(204);

      const row = await prisma.codeItem.findUniqueOrThrow({
        where: {
          groupCode_itemCode_bpCode: {
            groupCode: applied,
            itemCode: 'INTERN',
            bpCode: bpA.bpCode,
          },
        },
      });
      expect(row).toMatchObject({
        manageOwnerCode: 'BP_ONLY',
        createdBy: bmAId,
      });
      const other = await call('get', itemsPathOf(applied), { sub: bmBId });
      expect(itemCodesOf(other)).not.toContain('INTERN');
    });

    it('같은 그룹의 플랫폼 원본과 겹치면 — 이 BP 에 오지 않은 코드여도 — 409', async () => {
      const res = await create(applied, [item('LATE')]);
      expect(res.status).toBe(409);
      expect(bodyOf(res).message).toBe(
        '플랫폼이 등록한 상세 코드와 겹칩니다: LATE',
      );
    });

    it('플랫폼고정 그룹은 409, 사용중지 · 지운 그룹은 404, 아직 복사되지 않은 플랫폼제공 그룹에는 더할 수 있다', async () => {
      expect((await create(fixed, [item('NEW')])).status).toBe(409);
      expect((await create(stopped, [item('NEW')])).status).toBe(404);
      expect((await create(deleted, [item('NEW')])).status).toBe(404);
      expect((await create(notApplied, [item('NEW')])).status).toBe(204);
    });

    it('같은 코드를 동시에 만들면 하나만 생기고 나머지는 409', async () => {
      // 두 건만 — 일회용 DB(PGlite)는 백엔드 하나를 나눠 써서, 동시 트랜잭션이 많으면 서로의 결과가 섞인다
      // (플랫폼 공통코드 e2e 도 두 건으로 시험한다).
      const results = await Promise.all([
        create(applied, [item('RACE')]),
        create(applied, [item('RACE')]),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(
        await prisma.codeItem.count({
          where: { groupCode: applied, itemCode: 'RACE' },
        }),
      ).toBe(1);
    });
  });

  describe('수정', () => {
    it('꺼진 코드가 든 패널 전체를 그대로 저장할 수 있다 — 원본 상태를 묻지 않는다', async () => {
      const res = await update(applied, [
        item('FULL'),
        item('CONTRACT', { status: 'INACTIVE', label: '계약직' }),
      ]);
      expect(res.status).toBe(204);
    });

    it('그 BP 의 행만 고치고 플랫폼 원본은 그대로다', async () => {
      const res = await update(applied, [
        item('FULL', { label: '정규직', sortOrder: 3 }),
      ]);
      expect(res.status).toBe(204);

      const rows = await prisma.codeItem.findMany({
        where: { groupCode: applied, itemCode: 'FULL' },
        select: { bpCode: true, label: true, sortOrder: true },
      });
      expect(rows).toEqual(
        expect.arrayContaining([
          { bpCode: bpA.bpCode, label: '정규직', sortOrder: 3 },
          { bpCode: 'BP000000', label: '코드 FULL', sortOrder: 1 },
        ]),
      );
    });

    it('플랫폼이 사용 중지한 코드도 BP 가 사용으로 켤 수 있다', async () => {
      const res = await update(applied, [
        item('CONTRACT', { status: 'ACTIVE' }),
      ]);
      expect(res.status).toBe(204);
      const row = await prisma.codeItem.findUniqueOrThrow({
        where: {
          groupCode_itemCode_bpCode: {
            groupCode: applied,
            itemCode: 'CONTRACT',
            bpCode: bpA.bpCode,
          },
        },
        select: { status: true },
      });
      expect(row.status).toBe('ACTIVE');
    });

    it('그 BP 에 없는 코드(플랫폼 원본에만 있는 것 포함)는 404', async () => {
      const res = await update(applied, [item('LATE')]);
      expect(res.status).toBe(404);
    });

    it('사용중지 그룹은 보이지 않아 상세 코드 조회 · 수정이 404', async () => {
      expect((await call('get', itemsPathOf(stopped))).status).toBe(404);
      expect((await update(stopped, [item('ONE')])).status).toBe(404);
    });
  });

  describe('삭제', () => {
    const remove = (groupCode: string, itemCodes: string[], sub = bmAId) =>
      call('delete', itemsPathOf(groupCode), { sub, body: { itemCodes } });

    it('그 BP 의 행을 논리 삭제하고, 같은 코드로 다시 등록하면 그 행을 되살린다', async () => {
      expect((await create(applied, [item('DROP')])).status).toBe(204);

      expect((await remove(applied, ['drop'])).status).toBe(204);

      const row = await prisma.codeItem.findUniqueOrThrow({
        where: {
          groupCode_itemCode_bpCode: {
            groupCode: applied,
            itemCode: 'DROP',
            bpCode: bpA.bpCode,
          },
        },
        select: { isDeleted: true, updatedBy: true },
      });
      expect(row).toEqual({ isDeleted: true, updatedBy: bmAId });
      expect(
        itemCodesOf(await call('get', itemsPathOf(applied))),
      ).not.toContain('DROP');
      expect((await remove(applied, ['DROP'])).status).toBe(404);
      const again = await create(applied, [
        item('DROP', { label: '다시 쓴 이름', sortOrder: 7 }),
      ]);
      expect(again.status).toBe(204);
      await expect(
        prisma.codeItem.findUniqueOrThrow({
          where: {
            groupCode_itemCode_bpCode: {
              groupCode: applied,
              itemCode: 'DROP',
              bpCode: bpA.bpCode,
            },
          },
          select: {
            isDeleted: true,
            label: true,
            sortOrder: true,
            manageOwnerCode: true,
          },
        }),
      ).resolves.toEqual({
        isDeleted: false,
        label: '다시 쓴 이름',
        sortOrder: 7,
        manageOwnerCode: 'BP_ONLY',
      });
    });

    it('복사된 플랫폼제공 코드도 지운다 — 플랫폼 원본은 그대로이고, 다시 등록하면 BP전용 행으로 되살아난다', async () => {
      expect((await remove(applied, ['FULL'])).status).toBe(204);

      const rows = await prisma.codeItem.findMany({
        where: { groupCode: applied, itemCode: 'FULL' },
        select: { bpCode: true, isDeleted: true },
      });
      expect(rows).toEqual(
        expect.arrayContaining([
          { bpCode: bpA.bpCode, isDeleted: true },
          { bpCode: 'BP000000', isDeleted: false },
        ]),
      );
      expect((await create(applied, [item('FULL')])).status).toBe(204);
      await expect(
        prisma.codeItem.findUniqueOrThrow({
          where: {
            groupCode_itemCode_bpCode: {
              groupCode: applied,
              itemCode: 'FULL',
              bpCode: bpA.bpCode,
            },
          },
          select: { isDeleted: true, manageOwnerCode: true },
        }),
      ).resolves.toEqual({
        isDeleted: false,
        manageOwnerCode: 'BP_ONLY',
      });
    });

    it('다른 BP 의 코드는 지우지 못한다(404) · 플랫폼 사용자는 403', async () => {
      expect((await create(applied, [item('MINE')])).status).toBe(204);

      expect((await remove(applied, ['MINE'], bmBId)).status).toBe(404);
      const platform = await call('delete', itemsPathOf(applied), {
        sub: platformAdminId,
        bpCodeId: bpA.bpCodeId,
        body: { itemCodes: ['MINE'] },
      });
      expect(platform.status).toBe(403);
    });

    // 두 건만 — 일회용 DB(PGlite)는 백엔드 하나를 나눠 쓴다(등록의 동시 시험과 같다).
    it('같은 코드를 동시에 지우면 한 번만 지우고 나머지는 404 · 409 — 500 이 아니다', async () => {
      expect((await create(applied, [item('TWICE')])).status).toBe(204);

      const results = await Promise.all([
        remove(applied, ['TWICE']),
        remove(applied, ['TWICE']),
      ]);

      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      expect(statuses.every((s) => [204, 404, 409].includes(s))).toBe(true);
      await expect(
        prisma.codeItem.findUniqueOrThrow({
          where: {
            groupCode_itemCode_bpCode: {
              groupCode: applied,
              itemCode: 'TWICE',
              bpCode: bpA.bpCode,
            },
          },
          select: { isDeleted: true },
        }),
      ).resolves.toEqual({ isDeleted: true });
    });

    it('지운 코드를 동시에 다시 등록하면 한 번만 되살리고 나머지는 409', async () => {
      expect((await create(applied, [item('REVIVE')])).status).toBe(204);
      expect((await remove(applied, ['REVIVE'])).status).toBe(204);

      const results = await Promise.all([
        create(applied, [item('REVIVE')]),
        create(applied, [item('REVIVE')]),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(
        await prisma.codeItem.findMany({
          where: { groupCode: applied, itemCode: 'REVIVE' },
          select: { isDeleted: true },
        }),
      ).toEqual([{ isDeleted: false }]);
    });

    // 플랫폼고정 그룹은 BP 가 원본을 읽는다 — 플랫폼이 원본을 지우면 BP 화면에서도 곧바로 빠진다.
    it('플랫폼이 플랫폼고정 원본을 지우면 BP 화면에서도 곧바로 빠진다', async () => {
      const removed = await call('delete', `/code-groups/${fixed}/items`, {
        sub: platformAdminId,
        body: { itemCodes: ['ONE'] },
      });
      expect(removed.status).toBe(204);

      const res = await call('get', itemsPathOf(fixed));
      expect(res.status).toBe(200);
      expect(itemCodesOf(res)).toEqual([]);
    });
  });
});
