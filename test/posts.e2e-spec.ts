import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 공지사항 · FAQ 관리를 실제 DB 로 확인한다. 같은 글을 동시에 고칠 때 한쪽만 409 가 되는 것은 PostgreSQL 의
// 행 잠금 뒤 재평가에 달려 있어, 목으로는 가정만 할 수 있고 여기서만 증명된다.
describe('공지사항 · FAQ 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const n = randomInt(100_000, 999_999);
  let bpCodeId: number;
  let platformAdminId: number;
  let bpAdminId: number;

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

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        // 미사용 BP 다. 같이 도는 공통코드 e2e 의 BP 적용은 사용 중인 BP 에만 행을 넣는다.
        accountStatusCode: 'INACTIVE',
        tradeName: '게시물 테스트 BP',
      },
    }));
    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const group = (roleCode: string) =>
      prisma.roleGroup.findFirstOrThrow({ where: { roleCode } });
    const admin = async (loginId: string, roleTypeCode: 'PA' | 'BA') =>
      (
        await prisma.adminAccount.create({
          data: {
            loginId,
            name: roleTypeCode === 'PA' ? '운영자' : 'BP관리자',
            bpCodeId: roleTypeCode === 'PA' ? platformBp.bpCodeId : bpCodeId,
            passwordHash: '!',
            roleTypeCode,
            roleGroupId: (
              await group(roleTypeCode === 'PA' ? 'PM000001' : 'BM000001')
            ).roleGroupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            isAllStores: true,
            accountStatusCode: 'ACTIVE',
          },
        })
      ).adminAccountId;
    platformAdminId = await admin(`pspa${n}`, 'PA');
    bpAdminId = await admin(`psba${n}`, 'BA');
  });

  afterAll(async () => {
    const posts = { createdBy: platformAdminId };
    await prisma.postAudience.deleteMany({ where: { post: posts } });
    await prisma.post.deleteMany({ where: posts });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: [platformAdminId, bpAdminId] } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: [platformAdminId, bpAdminId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
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
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    body?: object,
    sub = platformAdminId,
  ) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${await tokenOf(sub)}`);
    return body ? req.send(body) : req;
  };

  type PostBody = {
    postId: number;
    updatedAt: string;
    title: string;
    audiences: string[];
  };
  const bodyOf = (res: { body: unknown }) => res.body as PostBody;

  const notice = {
    contentType: 'NOTICE',
    title: `점검 안내 ${n}`,
    body: '10월 20일 새벽 점검',
    status: 'PUBLISHED',
    noticeType: 'MAINTENANCE',
    isPinned: true,
    publishStartDate: '2026-10-14',
    publishEndDate: '2026-10-20',
    audiences: ['GUEST', 'MEMBER', 'BP', 'STORE'],
  };

  it('플랫폼 관리자가 아니면 403', async () => {
    const res = await call(
      'get',
      '/posts?contentType=NOTICE',
      undefined,
      bpAdminId,
    );
    expect(res.status).toBe(403);
  });

  it('노출 대상 없이 게시하면 400, 부가서비스 대상은 1차에 받지 않는다', async () => {
    expect(
      (await call('post', '/posts', { ...notice, audiences: [] })).status,
    ).toBe(400);
    expect(
      (await call('post', '/posts', { ...notice, audiences: ['ADDON'] }))
        .status,
    ).toBe(400);
  });

  it('등록하면 상세를 돌려주고, 목록에 고정 표시 · 수정자 이름과 함께 나온다', async () => {
    const created = await call('post', '/posts', notice);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      contentType: 'NOTICE',
      status: 'PUBLISHED',
      publishStartDate: '2026-10-14',
      publishEndDate: '2026-10-20',
      audiences: ['GUEST', 'MEMBER', 'BP', 'STORE'],
      updatedBy: platformAdminId,
      updatedByName: '운영자',
    });

    const list = await call(
      'get',
      '/posts?contentType=NOTICE&status=PUBLISHED&pageSize=200',
    );
    expect(list.status).toBe(200);
    const { items } = list.body as { items: PostBody[] };
    const item = items.find((i) => i.postId === bodyOf(created).postId);
    expect(item).toMatchObject({ isPinned: true, updatedByName: '운영자' });
  });

  it('FAQ 는 공통코드 카테고리로 등록되고 공지사항 칸은 비운다', async () => {
    const res = await call('post', '/posts', {
      contentType: 'FAQ',
      title: `FAQ ${n}`,
      body: '답',
      status: 'DRAFT',
      faqCategoryCode: 'BILLING',
      isPinned: true,
      audiences: [],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      faqCategoryCode: 'BILLING',
      isPinned: false,
      noticeType: null,
    });

    const bad = await call('post', '/posts', {
      contentType: 'FAQ',
      title: 'x',
      body: 'y',
      status: 'DRAFT',
      faqCategoryCode: 'NOPE',
      audiences: [],
    });
    expect(bad.status).toBe(400);
  });

  it('같은 글을 동시에 고치면 하나만 되고 나머지는 409', async () => {
    const post = bodyOf(await call('post', '/posts', notice));
    const edit = (title: string) =>
      call('put', `/posts/${post.postId}`, {
        ...notice,
        contentType: undefined,
        title,
        audiences: ['MEMBER'],
        updatedAt: post.updatedAt,
      });
    const results = await Promise.all([edit('A'), edit('B'), edit('C')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);

    const after = bodyOf(await call('get', `/posts/${post.postId}`));
    expect(after.audiences).toEqual(['MEMBER']);
    expect(['A', 'B', 'C']).toContain(after.title);

    // 옛 updatedAt 으로 다시 고쳐도 409. 상세를 다시 읽은 updatedAt 이면 된다.
    expect((await edit('D')).status).toBe(409);
    const retry = await call('put', `/posts/${post.postId}`, {
      ...notice,
      contentType: undefined,
      title: 'E',
      updatedAt: after.updatedAt,
    });
    expect(retry.status).toBe(200);
  });

  it('지우면 204, 다시 지우면 409, 상세는 404', async () => {
    const post = bodyOf(await call('post', '/posts', notice));
    expect((await call('delete', `/posts/${post.postId}`)).status).toBe(204);
    expect((await call('delete', `/posts/${post.postId}`)).status).toBe(409);
    expect((await call('get', `/posts/${post.postId}`)).status).toBe(404);
    const row = await prisma.post.findUniqueOrThrow({
      where: { postId: post.postId },
    });
    expect(row.isDeleted).toBe(true);
  });

  it('정수 범위 밖 ID 는 500 이 아니라 404', async () => {
    expect((await call('get', '/posts/2147483648')).status).toBe(404);
  });
});
