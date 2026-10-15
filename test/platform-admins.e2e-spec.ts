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
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
} from '../src/auth/access-messages';
import { PLATFORM_ADMIN_MAIL } from '../src/platform-admins/platform-admin-mail';
import type {
  PlatformAdminDetailResponseDto,
  PlatformAdminListResponseDto,
} from '../src/platform-admins/dto/platform-admin.response.dto';
import { PrismaService } from '../src/prisma/prisma.service';

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
    method: 'get' | 'put',
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
  });
});
