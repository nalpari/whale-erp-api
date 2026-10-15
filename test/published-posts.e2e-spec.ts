import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import type { PostAudienceType, Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, kstToday } from '../src/staff-members/kst-date';

// 비로그인 홈 · 고객지원의 공지사항 · FAQ 조회를 실제 DB 로 확인한다. 노출 판정(노출 대상 · 게시 상태 · 지움 ·
// 게시 기간)과 정렬(고정 먼저, 게시일 = 시작일 없으면 등록 일시)은 SQL 이라 목으로는 증명되지 않는다.
// 다른 e2e 의 글이 섞이지 않게 모든 조회를 이 실행의 번호(keyword)로 거른다.
describe('공지사항 · FAQ 공개 · 고객지원 조회 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  const today = kstToday();
  let bpCodeId: number;
  let platformAdminId: number;
  let bpAdminId: number;
  let storeAdminId: number;
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
    const admin = async (roleTypeCode: 'PA' | 'BA' | 'FA', group: string) =>
      (
        await prisma.adminAccount.create({
          data: {
            loginId: `pp${roleTypeCode.toLowerCase()}${n}`,
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
            accountStatusCode: 'ACTIVE',
          },
        })
      ).adminAccountId;
    platformAdminId = await admin('PA', 'PM000001');
    bpAdminId = await admin('BA', 'BM000001');
    storeAdminId = await admin('FA', 'FM000001');

    // 등록 순서가 곧 post_id 순서다 — 같은 게시일끼리는 post_id 내림차순이다.
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
    await post('bpOnly', ['BP']);
    await post('storeOnly', ['STORE']);
    await post('memberOnly', ['MEMBER']);
    await post('faqBilling', ['GUEST'], {
      contentType: 'FAQ',
      noticeType: null,
      faqCategoryCode: 'BILLING',
      body: '결제 수단은 50% 할인',
    });
    await post('faqAccount', ['GUEST'], {
      contentType: 'FAQ',
      noticeType: null,
      faqCategoryCode: 'ACCOUNT',
    });
  });

  afterAll(async () => {
    const posts = { createdBy: platformAdminId };
    await prisma.postAudience.deleteMany({ where: { post: posts } });
    await prisma.post.deleteMany({ where: posts });
    const admins = [platformAdminId, bpAdminId, storeAdminId];
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: admins } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: admins } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
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

  it('비로그인: 비회원 대상 게시 글만, 고정 먼저 · 게시일 내림차순', async () => {
    const res = await get(`/public-posts?contentType=NOTICE&keyword=${n}`);
    expect(res.status).toBe(200);
    // 임시저장 · 비공개 · 지움 · 시작 전 · 끝남 · 비회원 대상 아님은 빠진다. 종료일 당일은 보인다.
    expect(keysOf(res)).toEqual([
      'pinned',
      'endsToday',
      'started1DayAgo',
      'started2DaysAgo',
    ]);
    expect(res.body).toMatchObject({ total: 4 });
    const items = (res.body as { items: Item[] }).items;
    expect(items[3].postedDate).toBe(
      addDays(today, -2).toISOString().slice(0, 10),
    );
  });

  it('쪽을 나눠도 total 은 전체 건수다', async () => {
    const res = await get(
      `/public-posts?contentType=NOTICE&keyword=${n}&page=2&pageSize=3`,
    );
    expect(keysOf(res)).toEqual(['started2DaysAgo']);
    expect(res.body).toMatchObject({ total: 4 });
  });

  it('FAQ 는 카테고리로 거르고, 검색어의 % 는 글자 그대로 찾는다', async () => {
    const byCategory = await get(
      `/public-posts?contentType=FAQ&keyword=${n}&faqCategoryCode=BILLING`,
    );
    expect(keysOf(byCategory)).toEqual(['faqBilling']);

    const literal = await get(`/public-posts?contentType=FAQ&keyword=50%25`);
    expect(keysOf(literal)).toContain('faqBilling');
    expect(keysOf(literal)).not.toContain('faqAccount');
  });

  it('비로그인 상세: 보이는 글은 200, 비공개 · 지움 · 기간 밖 · 대상 밖은 404', async () => {
    expect((await get(`/public-posts/${ids.pinned}`)).status).toBe(200);
    for (const key of [
      'private',
      'draft',
      'deleted',
      'ended',
      'notYet',
      'bpOnly',
    ])
      expect((await get(`/public-posts/${ids[key]}`)).status).toBe(404);
  });

  it('고객지원: BP 관리자는 회원 · BP 대상 글을 본다', async () => {
    const res = await get(
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      bpAdminId,
    );
    expect(res.status).toBe(200);
    expect(keysOf(res)).toEqual(['pinned', 'memberOnly', 'bpOnly']);
  });

  it('고객지원: 가맹 관리자는 회원 · 점포 대상, 플랫폼 관리자는 회원 대상만 본다', async () => {
    const store = await get(
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      storeAdminId,
    );
    expect(keysOf(store)).toEqual(['memberOnly', 'storeOnly']);
    expect(
      (await get(`/support-posts/${ids.bpOnly}`, storeAdminId)).status,
    ).toBe(404);

    const platform = await get(
      `/support-posts?contentType=NOTICE&keyword=${n}`,
      platformAdminId,
    );
    expect(keysOf(platform)).toEqual(['memberOnly']);
  });

  it('고객지원은 토큰이 없으면 401', async () => {
    expect((await get('/support-posts?contentType=NOTICE')).status).toBe(401);
  });
});
