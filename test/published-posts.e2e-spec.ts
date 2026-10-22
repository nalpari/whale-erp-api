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
import { STORAGE } from '../src/storage/storage.module';

// 비로그인 홈 · 고객지원의 공지사항 · FAQ 조회를 실제 DB 로 확인한다. 노출 판정(노출 대상 · 게시 상태 · 지움 ·
// 게시 기간)과 정렬(고정 먼저, 게시일 = 시작일 없으면 등록 일시)은 SQL 이라 목으로는 증명되지 않는다.
// 다른 e2e 의 글이 섞이지 않게 목록은 이 실행의 번호(keyword)로 거른다. 특수 문자 검색만 번호 없이 찾으므로
// toContain 으로 본다. 상세의 이전 · 다음도 번호 없이 판정되므로 아주 오래된 게시일에 따로 둔다(아래 「이웃」).
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
  /** 첨부 행(post_attachments) — 저장소는 목이라 주소만 돌려준다. */
  const attachmentIds: Record<string, number> = {};
  const storage = {
    downloadUrl: jest.fn((key: string) => Promise.resolve(`signed:${key}`)),
  };

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STORAGE)
      .useValue(storage)
      .compile();
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
    await post('memberOnly', ['MEMBER'], { body: `bodyonly${n}` });
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
    // 이전 · 다음 — 게시일이 아주 오래된 회원 대상 공지사항 셋과, 그 사이에 끼었지만 플랫폼 관리자에게는
    // 보이지 않는 글 둘(BP 전용 · 임시저장). 같은 게시일에서는 나중에 만든 글(post_id 큼)이 위라, BP 전용은
    // oldMiddle 위에, 임시저장은 oldest 위에 선다 — 그래서 oldest 를 임시저장보다 먼저 만든다. 회원 대상 고정 글
    // 하나는 게시일이 가장 일러 고정 글 가운데 맨 아래에 선다. 제목에 이 실행의 번호를 넣지 않아 위 목록 기대값에는
    // 섞이지 않는다.
    await post('oldNewest', ['MEMBER'], {
      title: `이웃 oldNewest`,
      publishStartDate: addDays(today, -9000),
    });
    await post('oldMiddle', ['MEMBER'], {
      title: `이웃 oldMiddle`,
      publishStartDate: addDays(today, -9001),
    });
    await post('oldBpOnly', ['BP'], {
      title: `이웃 oldBpOnly`,
      publishStartDate: addDays(today, -9001),
    });
    await post('oldest', ['MEMBER'], {
      title: `이웃 oldest`,
      publishStartDate: addDays(today, -9002),
    });
    await post('oldDraft', ['MEMBER'], {
      title: `이웃 oldDraft`,
      status: 'DRAFT',
      publishStartDate: addDays(today, -9002),
    });
    await post('oldPinned', ['MEMBER'], {
      title: `이웃 oldPinned`,
      isPinned: true,
      publishStartDate: addDays(today, -9003),
    });
    // 로그인한 관리자에게 보이는 FAQ — 고객지원 FAQ 상세가 메뉴(`/support-faqs`, 현재 MN000043)로 판정되는지 본다.
    await post('faqMember', ['MEMBER'], {
      contentType: 'FAQ',
      noticeType: null,
      faqCategoryCode: 'ACCOUNT',
    });

    // 첨부(WHALEERP-280 · 292). 비회원에게 보이는 공지 · 비공개 공지 · 회원 전용 공지 · FAQ(API 는 FAQ 첨부를 받지
    // 않지만 행이 있어도 내주지 않는지 본다)에 하나씩, 비회원 공지에는 뺀 첨부도 하나 둔다.
    const attach = async (
      key: string,
      postKey: string,
      sortOrder: number,
      isDeleted = false,
    ) => {
      ({ postAttachmentId: attachmentIds[key] } =
        await prisma.postAttachment.create({
          data: {
            postId: ids[postKey],
            fileName: `${key}.pdf`,
            fileType: 'PDF',
            sizeBytes: 10,
            storageKey: `posts/${ids[postKey]}/${key}.pdf`,
            sortOrder,
            isDeleted,
          },
        }));
    };
    await attach('guestFile', 'pinned', 1);
    await attach('guestRemoved', 'pinned', 2, true);
    await attach('privateFile', 'private', 1);
    await attach('memberFile', 'memberOnly', 1);
    await attach('faqFile', 'faqBilling', 1);
  });

  // 준비가 중간에 실패하면 뒤의 id 는 없다. undefined 조건은 Prisma 가 빼 버려 표 전체를 지우고, `in` 에 섞이면
  // 검증 오류로 던져 아래 정리가 모두 건너뛰어진다 — 만든 것만 지운다.
  afterAll(async () => {
    if (!prisma) return app?.close();
    if (platformAdminId) {
      const posts = { createdBy: platformAdminId };
      await prisma.postAttachment.deleteMany({ where: { post: posts } });
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
    const res = await get(`/public-notices?keyword=${n}`);
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
    const res = await get(`/public-notices?keyword=${n}&page=2&pageSize=3`);
    expect(keysOf(res)).toEqual([
      'startsToday',
      'started1DayAgo',
      'started2DaysAgo',
    ]);
    expect(res.body).toMatchObject({ total: 7 });
  });

  it('공지사항 구분으로 거르고, 없는 구분은 400', async () => {
    const maintenance = await get(
      `/public-notices?keyword=${n}&noticeType=MAINTENANCE`,
    );
    expect(keysOf(maintenance)).toEqual(['lateButOld']);
    const general = await get(
      `/public-notices?keyword=${n}&noticeType=GENERAL`,
    );
    expect(keysOf(general)).not.toContain('lateButOld');
    expect((await get('/public-notices?noticeType=KIOSK')).status).toBe(400);
  });

  it('구분 · 카테고리는 여러 개를 함께 받는다 — 하나라도 맞으면 나온다', async () => {
    // 테스트 글은 GENERAL · MAINTENANCE 뿐이라, FEATURE 를 함께 주면 MAINTENANCE 글만 남아야 한다.
    const maintenanceOrFeature = await get(
      `/public-notices?keyword=${n}&noticeType=MAINTENANCE&noticeType=FEATURE`,
    );
    expect(keysOf(maintenanceOrFeature)).toEqual(['lateButOld']);
    expect(
      (await get('/public-notices?noticeType=GENERAL&noticeType=KIOSK')).status,
    ).toBe(400);

    const faqs = await get(
      `/public-faqs?keyword=${n}&faqCategoryCode=BILLING&faqCategoryCode=NOPE`,
    );
    expect(keysOf(faqs)).toEqual(['faqBilling']);

    // 빈 카테고리(「전체」)는 전처럼 거르지 않는다.
    const empty = await get(`/public-faqs?keyword=${n}&faqCategoryCode=`);
    expect(keysOf(empty).sort()).toEqual(['faqAccount', 'faqBilling']);
  });

  it('FAQ 는 카테고리로 거르고, 검색어의 % · _ 는 글자 그대로, 대소문자 없이 찾는다', async () => {
    const byCategory = await get(
      `/public-faqs?keyword=${n}&faqCategoryCode=BILLING`,
    );
    expect(keysOf(byCategory)).toEqual(['faqBilling']);

    for (const keyword of ['50%25', 'a_b', 'A_B']) {
      const res = await get(`/public-faqs?keyword=${keyword}`);
      expect(keysOf(res)).toContain('faqBilling');
      expect(keysOf(res)).not.toContain('faqAccount');
    }
  });

  it('비로그인 상세: 보이는 글은 200, 비공개 · 지움 · 기간 밖 · 대상 밖은 404', async () => {
    const shown = await get(`/public-notices/${ids.pinned}`);
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
      'faqBilling', // 공지사항 경로로 묻는 FAQ
    ])
      expect((await get(`/public-notices/${ids[key]}`)).status).toBe(404);
  });

  it('고객지원: BP 관리자는 회원 · BP 대상 글을 본다 — 둘 다 드는 글도 한 번', async () => {
    const res = await get(`/support-notices?keyword=${n}`, bpAdminId);
    expect(res.status).toBe(200);
    expect(keysOf(res)).toEqual([
      'pinned',
      'memberAndBp',
      'memberOnly',
      'bpOnly',
    ]);
    expect(res.body).toMatchObject({ total: 4 });
    expect(
      (await get(`/support-notices/${ids.memberAndBp}`, bpAdminId)).status,
    ).toBe(200);
  });

  it('고객지원: 가맹 관리자는 회원 · 점포 대상, 플랫폼 관리자는 회원 대상만 본다', async () => {
    const store = await get(`/support-notices?keyword=${n}`, storeAdminId);
    expect(keysOf(store)).toEqual(['memberAndBp', 'memberOnly', 'storeOnly']);
    expect(
      (await get(`/support-notices/${ids.bpOnly}`, storeAdminId)).status,
    ).toBe(404);

    const platform = await get(
      `/support-notices?keyword=${n}`,
      platformAdminId,
    );
    expect(keysOf(platform)).toEqual(['memberAndBp', 'memberOnly']);
  });

  it('고객지원: 사용 중이 아닌 관리자는 목록 · 상세 모두 403', async () => {
    for (const path of [
      `/support-notices?keyword=${n}`,
      `/support-notices/${ids.memberOnly}`,
    ]) {
      const res = await get(path, inactiveAdminId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACCOUNT_UNAVAILABLE_MESSAGE });
    }
  });

  it('고객지원: 경로마다 그 메뉴의 조회 권한으로 판정한다 — 공지사항 권한이 없으면 공지사항 목록 · 상세 403', async () => {
    for (const path of [
      `/support-notices?keyword=${n}`,
      `/support-notices/${ids.memberOnly}`,
    ]) {
      const res = await get(path, faqOnlyAdminId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: ACCESS_DENIED_MESSAGE });
    }
    const faqs = await get(`/support-faqs?keyword=${n}`, faqOnlyAdminId);
    expect(faqs.status).toBe(200);
    expect(keysOf(faqs)).toEqual(['faqMember']);
  });

  it('고객지원 공지사항 검색어는 제목만 찾는다 — 본문에만 든 글자로는 안 나온다', async () => {
    const byTitle = await get(`/support-notices?keyword=${n}`, platformAdminId);
    expect(keysOf(byTitle)).toContain('memberOnly');
    const byBody = await get(
      `/support-notices?keyword=bodyonly${n}`,
      platformAdminId,
    );
    expect(keysOf(byBody)).toEqual([]);
  });

  // 이웃 판정은 이 실행의 번호로 거르지 않는다(목록 필터를 걸지 않는 것이 규칙이다). 아주 오래된 게시일(오늘 -
  // 9000일 언저리)에는 다른 e2e 나 앞선 실행의 글이 없다고 가정한다 — 끼면 postId 비교가 실패로 드러낸다.
  it('고객지원 공지사항 상세의 이전 · 다음: 보이는 글 안에서 목록 순서대로, FAQ ID 는 404', async () => {
    const res = await get(`/support-notices/${ids.oldMiddle}`, platformAdminId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      // 사이에 있는 BP 전용 · 임시저장 글은 플랫폼 관리자에게 보이지 않아 건너뛴다.
      prev: {
        postId: ids.oldest,
        title: '이웃 oldest',
        postedDate: postedDateOf(-9002),
      },
      next: { postId: ids.oldNewest, postedDate: postedDateOf(-9000) },
    });

    // BP 관리자에게는 BP 전용 글이 보인다 — 같은 게시일에서 post_id 가 큰 그 글이 oldMiddle 바로 위다. 부르는
    // 사람의 노출 대상이 이웃 판정에 쓰인다는 것도 함께 본다.
    const bp = await get(`/support-notices/${ids.oldMiddle}`, bpAdminId);
    expect(bp.body).toMatchObject({
      prev: { postId: ids.oldest },
      next: { postId: ids.oldBpOnly },
    });

    // FAQ 는 상세가 없다 — 공지사항 경로로 FAQ ID 를 물으면 없는 글처럼 404 다.
    const faq = await get(`/support-notices/${ids.faqMember}`, platformAdminId);
    expect(faq.status).toBe(404);
  });

  // 고정 글의 맨 아래와 일반 글의 맨 위는 서로 이웃이다. 그 일반 글이 무엇인지는 DB 의 다른 글에 달려 고정값으로
  // 보지 않고, 「고정 글이 아니고, 그 글의 다음이 다시 이 고정 글」이라는 성질만 본다.
  it('고객지원 이전 · 다음은 상단 고정 글과 일반 글 사이도 목록 순서대로 잇는다', async () => {
    const pinned = await get(
      `/support-notices/${ids.oldPinned}`,
      platformAdminId,
    );
    const prev = (pinned.body as { prev: { postId: number } | null }).prev;
    expect(prev).not.toBeNull();
    const below = await get(
      `/support-notices/${prev!.postId}`,
      platformAdminId,
    );
    expect(below.body).toMatchObject({
      isPinned: false,
      next: { postId: ids.oldPinned },
    });
  });

  it('고객지원은 토큰이 없으면 401', async () => {
    expect((await get('/support-notices')).status).toBe(401);
  });

  describe('첨부파일 (WHALEERP-280 · 292)', () => {
    const downloadPath = (base: string, postKey: string, key: string) =>
      `${base}/${ids[postKey]}/attachments/${attachmentIds[key]}/download-url`;

    it('비로그인 상세는 지우지 않은 첨부만 싣고, 목록에는 첨부가 없다', async () => {
      const res = await get(`/public-notices/${ids.pinned}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        attachments: [
          {
            postAttachmentId: attachmentIds.guestFile,
            fileName: 'guestFile.pdf',
            fileType: 'PDF',
            sizeBytes: 10,
          },
        ],
      });
      expect((res.body as { attachments: unknown[] }).attachments).toHaveLength(
        1,
      );
      const list = await get(`/public-notices?keyword=${n}`);
      const items = (list.body as { items: object[] }).items;
      expect(items.every((i) => !('attachments' in i))).toBe(true);
    });

    it('비로그인 내려받기 주소: 비회원에게 보이는 공지의 지우지 않은 첨부만', async () => {
      const ok = await get(
        downloadPath('/public-notices', 'pinned', 'guestFile'),
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        url: `signed:posts/${ids.pinned}/guestFile.pdf`,
      });

      for (const [postKey, key] of [
        ['pinned', 'guestRemoved'], // 뺀 첨부
        ['private', 'privateFile'], // 비공개 글
        ['memberOnly', 'memberFile'], // 비회원 대상 아님
        ['faqBilling', 'faqFile'], // FAQ
        ['started1DayAgo', 'guestFile'], // 다른 글의 첨부 ID
      ])
        expect([
          postKey,
          key,
          (await get(downloadPath('/public-notices', postKey, key))).status,
        ]).toEqual([postKey, key, 404]);
    });

    it('고객지원: 그 관리자에게 보이는 공지의 첨부만, 공지사항 조회 권한이 있어야 한다', async () => {
      const detail = await get(
        `/support-notices/${ids.memberOnly}`,
        platformAdminId,
      );
      expect(detail.body).toMatchObject({
        attachments: [{ postAttachmentId: attachmentIds.memberFile }],
      });
      const ok = await get(
        downloadPath('/support-notices', 'memberOnly', 'memberFile'),
        platformAdminId,
      );
      expect(ok.status).toBe(200);

      // 비회원 전용 글은 로그인한 관리자에게 보이지 않는다(회원 대상 아님).
      expect(
        (
          await get(
            downloadPath('/support-notices', 'pinned', 'guestFile'),
            platformAdminId,
          )
        ).status,
      ).toBe(404);
      const faqOnly = await get(
        downloadPath('/support-notices', 'memberOnly', 'memberFile'),
        faqOnlyAdminId,
      );
      expect(faqOnly.status).toBe(403);
      expect(faqOnly.body).toMatchObject({ message: ACCESS_DENIED_MESSAGE });
      expect(
        (
          await get(
            downloadPath('/support-notices', 'memberOnly', 'memberFile'),
          )
        ).status,
      ).toBe(401);
    });
  });
});
