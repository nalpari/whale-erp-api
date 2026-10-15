import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import type { PostAudienceType, Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../src/auth/access-messages';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstToday } from '../src/staff-members/kst-date';

// 비로그인 홈 · 고객지원의 공지사항 · FAQ 조회를 실제 DB 로 확인한다. 노출 판정(노출 대상 · 게시 상태 · 지움 ·
// 게시 기간)과 정렬(고정 먼저, 게시일 = 시작일 없으면 등록 일시)은 SQL 이라 목으로는 증명되지 않는다.
// 다른 e2e 의 글이 섞이지 않게 목록은 이 실행의 번호(keyword)로 거른다. 특수 문자 검색만 번호 없이 찾으므로
// toContain 으로 본다.
describe('공지사항 · FAQ 공개 · 고객지원 조회 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  const today = kstToday();
  let bpCodeId: number;
  let platformAdminId: number;
  let bpAdminId: number;
  let storeAdminId: number;
  let inactiveAdminId: number;
  let faqOnlyAdminId: number;
  let faqOnlyGroupId: number;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'INACTIVE',
        tradeName: '공개 게시물 테스트 BP',
      },
    }));
    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const admin = async (
      roleTypeCode: 'PA' | 'BA' | 'FA',
      group: string,
      accountStatusCode = 'ACTIVE',
      prefix = 'pp',
    ) =>
      (
        await prisma.adminAccount.create({
          data: {
            loginId: `${prefix}${roleTypeCode.toLowerCase()}${accountStatusCode === 'ACTIVE' ? '' : 'x'}${n}`,
            name: roleTypeCode,
            bpCodeId: roleTypeCode === 'PA' ? platformBp.bpCodeId : bpCodeId,
            passwordHash: '!',
            roleTypeCode,
            roleGroupId: (
              await prisma.roleGroup.findFirstOrThrow({
                where: { roleCode: group },
              })
            ).roleGroupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            isAllStores: true,
            accountStatusCode,
          },
        })
      ).adminAccountId;
    platformAdminId = await admin('PA', 'PM000001');
    bpAdminId = await admin('BA', 'BM000001');
    storeAdminId = await admin('FA', 'FM000001');
    inactiveAdminId = await admin('FA', 'FM000001', 'INACTIVE');
    // FAQ(MN000043) 조회만 있고 공지사항(MN000035) 권한은 없는 그룹.
    ({ roleGroupId: faqOnlyGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `FA${n}`,
        bpCodeId,
        roleTypeCode: 'FA',
        name: `FAQ 만 ${n}`,
        menus: {
          create: {
            menu: { connect: { menuCode: 'MN000043' } },
            isReadable: true,
          },
        },
      },
    }));
    faqOnlyAdminId = await admin('FA', `FA${n}`, 'ACTIVE', 'fq');

    // 등록 순서가 곧 post_id 순서다. 등록 순서 · post_id 와 게시일 순서가 어긋나게 넣어, 정렬이 정말
    // 「시작일, 없으면 등록 일시」인지 본다 — 고정 글끼리도 같은 기준이다.
    const post = async (
      key: string,
      audiences: PostAudienceType[],
      data: Partial<Prisma.PostUncheckedCreateInput> = {},
    ) => {
      const { postId } = await prisma.post.create({
        data: {
          contentType: 'NOTICE',
          noticeType: 'GENERAL',
          title: `[${n}] ${key}`,
          body: '본문',
          status: 'PUBLISHED',
          createdBy: platformAdminId,
          updatedBy: platformAdminId,
          postAudiences: {
            create: audiences.map((audienceType) => ({ audienceType })),
          },
          ...data,
        },
      });
      ids[key] = postId;
    };
    await post('started2DaysAgo', ['GUEST'], {
      publishStartDate: addDays(today, -2),
    });
    await post('pinned', ['GUEST', 'BP'], { isPinned: true });
    await post('started1DayAgo', ['GUEST'], {
      publishStartDate: addDays(today, -1),
    });
    await post('draft', ['GUEST'], { status: 'DRAFT' });
    await post('private', ['GUEST'], { status: 'PRIVATE' });
    await post('deleted', ['GUEST'], { isDeleted: true });
    await post('notYet', ['GUEST'], { publishStartDate: addDays(today, 3) });
    await post('ended', ['GUEST'], {
      publishStartDate: addDays(today, -5),
      publishEndDate: addDays(today, -1),
    });
    await post('endsToday', ['GUEST'], { publishEndDate: today });
    await post('startsToday', ['GUEST'], { publishStartDate: today });
    await post('pinnedOld', ['GUEST'], {
      isPinned: true,
      publishStartDate: addDays(today, -3),
    });
    await post('pinnedEnded', ['GUEST'], {
      isPinned: true,
      publishStartDate: addDays(today, -5),
      publishEndDate: addDays(today, -1),
    });
    await post('bpOnly', ['BP']);
    await post('storeOnly', ['STORE']);
    await post('memberOnly', ['MEMBER']);
    // 노출 대상 둘에 함께 드는 글 — 한 번만 나오고 한 번만 세야 한다.
    await post('memberAndBp', ['MEMBER', 'BP']);
    // 가장 늦게 등록했지만 게시일은 가장 이르다.
    await post('lateButOld', ['GUEST'], {
      noticeType: 'MAINTENANCE',
      publishStartDate: addDays(today, -5),
    });
    await post('faqBilling', ['GUEST'], {
      contentType: 'FAQ',
      noticeType: null,
      faqCategoryCode: 'BILLING',
      body: `결제 수단은 50% 할인 · a_b ${n}`,
    });
    await post('faqAccount', ['GUEST'], {
      contentType: 'FAQ',
      noticeType: null,
      faqCategoryCode: 'ACCOUNT',
      // LIKE 였다면 50% · a_b 에 걸리는 글자들이다.
      body: `500원 · axb ${n}`,
    });
    // 로그인한 관리자에게 보이는 FAQ — 고객지원 FAQ 상세가 MN000043 으로 판정되는지 본다.
    await post('faqMember', ['MEMBER'], {
      contentType: 'FAQ',
      noticeType: null,
      faqCategoryCode: 'ACCOUNT',
    });
  });

  // 준비가 중간에 실패하면 뒤의 id 는 없다. undefined 조건은 Prisma 가 빼 버려 표 전체를 지우고, `in` 에 섞이면
  // 검증 오류로 던져 아래 정리가 모두 건너뛰어진다 — 만든 것만 지운다.
  afterAll(async () => {
    if (!prisma) return app?.close();
    if (platformAdminId) {
      const posts = { createdBy: platformAdminId };
      await prisma.postAudience.deleteMany({ where: { post: posts } });
      await prisma.post.deleteMany({ where: posts });
    }
    const admins = [
      platformAdminId,
      bpAdminId,
      storeAdminId,
      inactiveAdminId,
      faqOnlyAdminId,
    ].filter((id) => id !== undefined);
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: admins } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: admins } },
    });
    if (faqOnlyGroupId) {
      await prisma.roleGroupMenu.deleteMany({
        where: { roleGroupId: faqOnlyGroupId },
      });
      await prisma.roleGroup.deleteMany({
        where: { roleGroupId: faqOnlyGroupId },
      });
    }
    if (bpCodeId) await prisma.bpCode.deleteMany({ where: { bpCodeId } });
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
  const get = async (path: string, sub?: number) => {
    const req = request(app.getHttpServer()).get(path);
    return sub ? req.set('Authorization', `Bearer ${await tokenOf(sub)}`) : req;
  };
  type Item = { postId: number; postedDate: string; isPinned: boolean };
  const keysOf = (res: { body: unknown }) => {
    const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
    return (res.body as { items: Item[] }).items.map((i) => byId.get(i.postId));
  };

  const postedDateOf = (days: number) =>
    addDays(today, days).toISOString().slice(0, 10);

  it('비로그인: 비회원 대상 게시 글만, 고정 먼저 · 게시일 내림차순', async () => {
    const res = await get(`/public-posts?contentType=NOTICE&keyword=${n}`);
    expect(res.status).toBe(200);
    // 임시저장 · 비공개 · 지움 · 시작 전 · 끝남(고정 글 포함) · 비회원 대상 아님은 빠진다. 시작일 · 종료일
    // 당일은 보인다. 시작일이 없는 글은 등록 일시(지금)라 시작일이 오늘(0시)인 글보다 앞선다.
    expect(keysOf(res)).toEqual([
      'pinned',
      'pinnedOld',
      'endsToday',
      'startsToday',
      'started1DayAgo',
      'started2DaysAgo',
      'lateButOld',
    ]);
    expect(res.body).toMatchObject({ total: 7 });
    const items = (res.body as { items: Item[] }).items;
    expect(items[1].postedDate).toBe(postedDateOf(-3));
    expect(items[6].postedDate).toBe(postedDateOf(-5));
  });

  it('쪽을 나눠도 total 은 전체 건수다', async () => {
    const res = await get(
      `/public-posts?contentType=NOTICE&keyword=${n}&page=2&pageSize=3`,
    );
    expect(keysOf(res)).toEqual([
      'startsToday',
      'started1DayAgo',
      'started2DaysAgo',
    ]);
    expect(res.body).toMatchObject({ total: 7 });
  });

  it('공지사항 구분으로 거르고, 없는 구분은 400', async () => {
    const maintenance = await get(
      `/public-posts?contentType=NOTICE&keyword=${n}&noticeType=MAINTENANCE`,
    );
    expect(keysOf(maintenance)).toEqual(['lateButOld']);
    const general = await get(
      `/public-posts?contentType=NOTICE&keyword=${n}&noticeType=GENERAL`,
    );
    expect(keysOf(general)).not.toContain('lateButOld');
    expect(
      (await get('/public-posts?contentType=NOTICE&noticeType=KIOSK')).status,
    ).toBe(400);
  });

  it('FAQ 는 카테고리로 거르고, 검색어의 % · _ 는 글자 그대로, 대소문자 없이 찾는다', async () => {
    const byCategory = await get(
      `/public-posts?contentType=FAQ&keyword=${n}&faqCategoryCode=BILLING`,
    );
    expect(keysOf(byCategory)).toEqual(['faqBilling']);

    for (const keyword of ['50%25', 'a_b', 'A_B']) {
      const res = await get(`/public-posts?contentType=FAQ&keyword=${keyword}`);
      expect(keysOf(res)).toContain('faqBilling');
      expect(keysOf(res)).not.toContain('faqAccount');
    }
  });

  it('비로그인 상세: 보이는 글은 200, 비공개 · 지움 · 기간 밖 · 대상 밖은 404', async () => {
    const shown = await get(`/public-posts/${ids.pinned}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ postId: ids.pinned, isPinned: true });
    for (const key of [
      'private',
      'draft',
      'deleted',
      'ended',
      'pinnedEnded',
      'notYet',
      'bpOnly',
    ])
      expect((await get(`/public-posts/${ids[key]}`)).status).toBe(404);
  });

  it('고객지원: BP 관리자는 회원 · BP 대상 글을 본다 — 둘 다 드는 글도 한 번', async () => {
    const res = await get(
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      bpAdminId,
    );
    expect(res.status).toBe(200);
    expect(keysOf(res)).toEqual([
      'pinned',
      'memberAndBp',
      'memberOnly',
      'bpOnly',
    ]);
    expect(res.body).toMatchObject({ total: 4 });
    expect(
      (await get(`/support-posts/${ids.memberAndBp}`, bpAdminId)).status,
    ).toBe(200);
  });

  it('고객지원: 가맹 관리자는 회원 · 점포 대상, 플랫폼 관리자는 회원 대상만 본다', async () => {
    const store = await get(
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      storeAdminId,
    );
    expect(keysOf(store)).toEqual(['memberAndBp', 'memberOnly', 'storeOnly']);
    expect(
      (await get(`/support-posts/${ids.bpOnly}`, storeAdminId)).status,
    ).toBe(404);

    const platform = await get(
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      platformAdminId,
    );
    expect(keysOf(platform)).toEqual(['memberAndBp', 'memberOnly']);
  });

  it('고객지원: 사용 중이 아닌 관리자는 목록 · 상세 모두 403', async () => {
    for (const path of [
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      `/support-posts/${ids.memberOnly}`,
    ]) {
      const res = await get(path, inactiveAdminId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACCOUNT_UNAVAILABLE_MESSAGE });
    }
  });

  it('고객지원: 글 종류마다 그 메뉴의 조회 권한으로 판정한다 — 공지사항 권한이 없으면 목록 · 상세 403', async () => {
    for (const path of [
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      `/support-posts/${ids.memberOnly}`,
    ]) {
      const res = await get(path, faqOnlyAdminId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACCESS_DENIED_MESSAGE });
    }
    const faqs = await get(
      `/support-posts?contentType=FAQ&keyword=${n}`,
      faqOnlyAdminId,
    );
    expect(faqs.status).toBe(200);
    expect(keysOf(faqs)).toEqual(['faqMember']);
    expect(
      (await get(`/support-posts/${ids.faqMember}`, faqOnlyAdminId)).status,
    ).toBe(200);
  });

  it('고객지원은 토큰이 없으면 401', async () => {
    expect((await get('/support-posts?contentType=NOTICE')).status).toBe(401);
  });
});
