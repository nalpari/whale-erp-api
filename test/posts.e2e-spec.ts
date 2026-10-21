import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE } from '../src/storage/storage.module';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const PDF = Buffer.from('%PDF-1.4');
const GIF = Buffer.from('GIF89a');

// 공지사항 · FAQ 관리를 실제 DB 로 확인한다. 같은 글을 동시에 고칠 때 한쪽만 409 가 되는 것은 PostgreSQL 의
// 행 잠금 뒤 재평가에 달려 있어, 목으로는 가정만 할 수 있고 여기서만 증명된다. 저장소는 목이다(부른 키만 남긴다).
describe('공지사항 · FAQ 관리 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const storage = {
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    downloadUrl: jest.fn((key: string) => Promise.resolve(`signed:${key}`)),
  };

  const n = randomInt(100_000, 999_999);
  let bpCodeId: number;
  let platformAdminId: number;
  let bpAdminId: number;
  let noticeReaderId: number;
  let noticeReaderGroupId: number;

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
    // 공지사항(MN000219) 조회 권한만 있는 플랫폼 권한 그룹 — 메뉴마다 경로를 나눈 판정을 본다.
    ({ roleGroupId: noticeReaderGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `PA${n}`,
        bpCodeId: platformBp.bpCodeId,
        roleTypeCode: 'PA',
        name: `공지 조회만 ${n}`,
        menus: {
          create: {
            menu: { connect: { menuCode: 'MN000219' } },
            isReadable: true,
          },
        },
      },
    }));
    const admin = async (
      loginId: string,
      roleTypeCode: 'PA' | 'BA',
      roleGroupId?: number,
    ) =>
      (
        await prisma.adminAccount.create({
          data: {
            loginId,
            name: roleTypeCode === 'PA' ? '운영자' : 'BP관리자',
            bpCodeId: roleTypeCode === 'PA' ? platformBp.bpCodeId : bpCodeId,
            passwordHash: '!',
            roleTypeCode,
            roleGroupId:
              roleGroupId ??
              (await group(roleTypeCode === 'PA' ? 'PM000001' : 'BM000001'))
                .roleGroupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            isAllStores: true,
            accountStatusCode: 'ACTIVE',
          },
        })
      ).adminAccountId;
    platformAdminId = await admin(`pspa${n}`, 'PA');
    bpAdminId = await admin(`psba${n}`, 'BA');
    noticeReaderId = await admin(`psnr${n}`, 'PA', noticeReaderGroupId);
  });

  afterAll(async () => {
    const posts = { createdBy: platformAdminId };
    await prisma.postAttachment.deleteMany({ where: { post: posts } });
    await prisma.postAudience.deleteMany({ where: { post: posts } });
    await prisma.post.deleteMany({ where: posts });
    const admins = [platformAdminId, bpAdminId, noticeReaderId];
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: admins } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: admins } },
    });
    const groups = { roleGroupId: noticeReaderGroupId };
    await prisma.roleGroupMenu.deleteMany({ where: groups });
    await prisma.roleGroup.deleteMany({ where: groups });
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
    const res = await call('get', '/platform-notices', undefined, bpAdminId);
    expect(res.status).toBe(403);
  });

  it('노출 대상 없이 게시하면 400, 부가서비스 대상은 1차에 받지 않는다', async () => {
    expect(
      (await call('post', '/platform-notices', { ...notice, audiences: [] }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('post', '/platform-notices', {
          ...notice,
          audiences: ['ADDON'],
        })
      ).status,
    ).toBe(400);
  });

  it('등록하면 상세를 돌려주고, 목록에 고정 표시 · 수정자 이름과 함께 나온다', async () => {
    const created = await call('post', '/platform-notices', notice);
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
      '/platform-notices?status=PUBLISHED&pageSize=200',
    );
    expect(list.status).toBe(200);
    const { items } = list.body as { items: PostBody[] };
    const item = items.find((i) => i.postId === bodyOf(created).postId);
    expect(item).toMatchObject({ isPinned: true, updatedByName: '운영자' });
  });

  it('FAQ 는 공통코드 카테고리로 등록되고 공지사항 칸은 비운다', async () => {
    const res = await call('post', '/platform-faqs', {
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

    const bad = await call('post', '/platform-faqs', {
      title: 'x',
      body: 'y',
      status: 'DRAFT',
      faqCategoryCode: 'NOPE',
      audiences: [],
    });
    expect(bad.status).toBe(400);
  });

  it('같은 글을 동시에 고치면 하나만 되고 나머지는 409', async () => {
    const post = bodyOf(await call('post', '/platform-notices', notice));
    const edit = (title: string) =>
      call('put', `/platform-notices/${post.postId}`, {
        ...notice,
        title,
        audiences: ['MEMBER'],
        updatedAt: post.updatedAt,
      });
    const results = await Promise.all([edit('A'), edit('B'), edit('C')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);

    const after = bodyOf(await call('get', `/platform-notices/${post.postId}`));
    expect(after.audiences).toEqual(['MEMBER']);
    expect(['A', 'B', 'C']).toContain(after.title);

    // 옛 updatedAt 으로 다시 고쳐도 409. 상세를 다시 읽은 updatedAt 이면 된다.
    expect((await edit('D')).status).toBe(409);
    const retry = await call('put', `/platform-notices/${post.postId}`, {
      ...notice,
      title: 'E',
      updatedAt: after.updatedAt,
    });
    expect(retry.status).toBe(200);
  });

  it('지우면 204, 다시 지우면 409, 상세는 404', async () => {
    const post = bodyOf(await call('post', '/platform-notices', notice));
    expect(
      (await call('delete', `/platform-notices/${post.postId}`)).status,
    ).toBe(204);
    expect(
      (await call('delete', `/platform-notices/${post.postId}`)).status,
    ).toBe(409);
    expect((await call('get', `/platform-notices/${post.postId}`)).status).toBe(
      404,
    );
    const row = await prisma.post.findUniqueOrThrow({
      where: { postId: post.postId },
    });
    expect(row.isDeleted).toBe(true);
  });

  it('메뉴마다 경로가 따로다 — 공지사항 조회 권한만 있으면 FAQ 와 공지 등록은 403', async () => {
    const as = (method: 'get' | 'post', path: string, body?: object) =>
      call(method, path, body, noticeReaderId).then((r) => r.status);
    expect(await as('get', '/platform-notices')).toBe(200);
    expect(await as('post', '/platform-notices', notice)).toBe(403);
    expect(await as('get', '/platform-faqs')).toBe(403);
  });

  it('다른 종류의 글 ID 는 없는 글처럼 404 이고, 목록은 경로의 종류만 준다', async () => {
    const faq = bodyOf(
      await call('post', '/platform-faqs', {
        title: `종류 ${n}`,
        body: '답',
        status: 'DRAFT',
        faqCategoryCode: 'BILLING',
        audiences: [],
      }),
    );
    expect((await call('get', `/platform-notices/${faq.postId}`)).status).toBe(
      404,
    );
    expect(
      (await call('delete', `/platform-notices/${faq.postId}`)).status,
    ).toBe(404);
    expect((await call('get', `/platform-faqs/${faq.postId}`)).status).toBe(
      200,
    );
    const ids = async (path: string) =>
      (
        (await call('get', `${path}?pageSize=200`)).body as {
          items: PostBody[];
        }
      ).items.map((i) => i.postId);
    expect(await ids('/platform-faqs')).toContain(faq.postId);
    expect(await ids('/platform-notices')).not.toContain(faq.postId);
  });

  it('정수 범위 밖 ID 는 500 이 아니라 404', async () => {
    expect((await call('get', '/platform-notices/2147483648')).status).toBe(
      404,
    );
  });

  describe('첨부파일 (WHALEERP-272)', () => {
    type Attachment = {
      postAttachmentId: number;
      fileName: string;
      fileType: string;
    };
    type WithAttachments = PostBody & { attachments: Attachment[] };

    /** multipart 로 보낸다. 배열은 같은 이름을 되풀이한다 — multipart 는 빈 배열 · null 을 보낼 수 없다. */
    const multipart = async (
      method: 'post' | 'put',
      path: string,
      fields: Record<string, string | string[] | number[]>,
      files: [string, Buffer][] = [],
      sub = platformAdminId,
    ) => {
      let req = request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${await tokenOf(sub)}`);
      for (const [name, value] of Object.entries(fields))
        for (const v of Array.isArray(value) ? value : [value])
          req = req.field(name, String(v));
      for (const [name, buffer] of files)
        req = req.attach('files', buffer, name);
      return req;
    };
    /** 등록 · 수정이 함께 받는 칸. 글 종류는 경로로 가른다. */
    const editFields = {
      title: `첨부 공지 ${n}`,
      body: '본문',
      status: 'PUBLISHED',
      noticeType: 'GENERAL',
      isPinned: 'true',
      publishStartDate: '',
      audiences: ['GUEST', 'MEMBER'],
    };
    const noticeFields = editFields;
    const rowsOf = (postId: number) =>
      prisma.postAttachment.findMany({
        where: { postId },
        orderBy: { postAttachmentId: 'asc' },
      });

    beforeEach(() => jest.clearAllMocks());

    it('공지사항을 첨부와 함께 multipart 로 등록한다 — 텍스트 칸은 JSON 과 같은 값이 된다', async () => {
      const res = await multipart('post', '/platform-notices', noticeFields, [
        ['사진.png', PNG],
        ['안내문.pdf', PDF],
      ]);
      expect(res.status).toBe(201);
      const post = res.body as WithAttachments;
      expect(post).toMatchObject({
        isPinned: true,
        publishStartDate: null,
        audiences: ['GUEST', 'MEMBER'],
        attachments: [
          { fileName: '사진.png', fileType: 'PNG', sizeBytes: 9 },
          { fileName: '안내문.pdf', fileType: 'PDF', sizeBytes: 8 },
        ],
      });
      const rows = await rowsOf(post.postId);
      expect(rows.map((r) => [r.sortOrder, r.fileType, r.isDeleted])).toEqual([
        [1, 'PNG', false],
        [2, 'PDF', false],
      ]);
      for (const r of rows)
        expect(r.storageKey.startsWith(`posts/${post.postId}/`)).toBe(true);
      expect(storage.put).toHaveBeenCalledTimes(2);
    });

    it('JSON 등록 · 수정은 그대로 된다 — 첨부는 빈 목록', async () => {
      const res = await call('post', '/platform-notices', notice);
      expect(res.status).toBe(201);
      expect((res.body as WithAttachments).attachments).toEqual([]);
    });

    it('FAQ 에 첨부를 보내면 400 이고 글도 만들지 않는다', async () => {
      const title = `FAQ 첨부 ${n}`;
      const res = await multipart(
        'post',
        '/platform-faqs',
        {
          title,
          body: '답',
          status: 'DRAFT',
          faqCategoryCode: 'BILLING',
        },
        [['a.png', PNG]],
      );
      expect(res.status).toBe(400);
      expect(await prisma.post.count({ where: { title } })).toBe(0);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('내용이 JPG · PNG · PDF 가 아니면(이름은 .png) 400, 6개면 400', async () => {
      expect(
        (
          await multipart('post', '/platform-notices', noticeFields, [
            ['x.png', GIF],
          ])
        ).status,
      ).toBe(400);
      const six = Array.from(
        { length: 6 },
        (_, i) => [`${i}.png`, PNG] as [string, Buffer],
      );
      expect(
        (await multipart('post', '/platform-notices', noticeFields, six))
          .status,
      ).toBe(400);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('수정에서 첨부를 빼고 더한다 — 뺀 행은 지움 표시, 파일은 지우고, 빈 자리를 다시 쓴다', async () => {
      const created = (
        await multipart('post', '/platform-notices', noticeFields, [
          ['1.png', PNG],
          ['2.pdf', PDF],
          ['3.png', PNG],
        ])
      ).body as WithAttachments;
      const [first, second] = created.attachments;
      const removedKey = (await rowsOf(created.postId))[1].storageKey;

      const res = await multipart(
        'put',
        `/platform-notices/${created.postId}`,
        {
          ...editFields,
          updatedAt: created.updatedAt,
          removeAttachmentIds: [second.postAttachmentId],
        },
        [['4.pdf', PDF]],
      );
      expect(res.status).toBe(200);
      const after = res.body as WithAttachments;
      expect(after.attachments.map((a) => a.fileName)).toEqual([
        '1.png',
        '3.png',
        '4.pdf',
      ]);
      expect(after.attachments[0].postAttachmentId).toBe(
        first.postAttachmentId,
      );
      const rows = await rowsOf(created.postId);
      expect(rows.map((r) => [r.fileName, r.sortOrder, r.isDeleted])).toEqual([
        ['1.png', 1, false],
        ['2.pdf', 2, true],
        ['3.png', 3, false],
        ['4.pdf', 2, false], // 뺀 첨부의 자리를 다시 쓴다
      ]);
      expect(storage.delete).toHaveBeenCalledWith(removedKey, {
        thumbnail: false,
      });

      // 남은 3개 + 3개는 5개를 넘는다 — 400 이고 아무것도 바뀌지 않는다.
      const over = await multipart(
        'put',
        `/platform-notices/${created.postId}`,
        { ...editFields, updatedAt: after.updatedAt },
        [
          ['5.png', PNG],
          ['6.png', PNG],
          ['7.png', PNG],
        ],
      );
      expect(over.status).toBe(400);
      expect(await rowsOf(created.postId)).toHaveLength(4);

      // 다른 글의 첨부 · 이미 뺀 첨부를 빼려 하면 400.
      const wrong = await multipart(
        'put',
        `/platform-notices/${created.postId}`,
        {
          ...editFields,
          updatedAt: after.updatedAt,
          removeAttachmentIds: [second.postAttachmentId],
        },
      );
      expect(wrong.status).toBe(400);
    });

    it('관리자 내려받기 주소: 지우지 않은 글의 지우지 않은 첨부만', async () => {
      const created = (
        await multipart('post', '/platform-notices', noticeFields, [
          ['a.pdf', PDF],
          ['b.pdf', PDF],
        ])
      ).body as WithAttachments;
      const [a, b] = created.attachments;
      const path = (postId: number, attachmentId: number) =>
        `/platform-notices/${postId}/attachments/${attachmentId}/download-url`;
      const [aRow] = await rowsOf(created.postId);

      const ok = await call('get', path(created.postId, a.postAttachmentId));
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ url: `signed:${aRow.storageKey}` });
      expect(
        (
          await call(
            'get',
            path(created.postId, a.postAttachmentId),
            undefined,
            bpAdminId,
          )
        ).status,
      ).toBe(403);

      // 뺀 첨부 · 다른 글 경로 · 지운 글은 404.
      await multipart('put', `/platform-notices/${created.postId}`, {
        ...editFields,
        updatedAt: created.updatedAt,
        removeAttachmentIds: [b.postAttachmentId],
      });
      expect(
        (await call('get', path(created.postId, b.postAttachmentId))).status,
      ).toBe(404);
      const other = bodyOf(await call('post', '/platform-notices', notice));
      expect(
        (await call('get', path(other.postId, a.postAttachmentId))).status,
      ).toBe(404);
      expect(
        (await call('delete', `/platform-notices/${created.postId}`)).status,
      ).toBe(204);
      expect(
        (await call('get', path(created.postId, a.postAttachmentId))).status,
      ).toBe(404);
      // 글을 지워도 첨부는 남는다 — 글을 되살릴 수 있게.
      expect(
        (await rowsOf(created.postId)).find(
          (r) => r.postAttachmentId === a.postAttachmentId,
        ),
      ).toMatchObject({ isDeleted: false });
    });
  });
});
