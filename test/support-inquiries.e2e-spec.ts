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
const GIF = Buffer.from('GIF89a');

// 고객지원 문의하기(WHALEERP-281)를 실제 DB 로 확인한다 — 메뉴 권한 가드, 본인 문의만 보이는 범위, 5분 중복 409.
// 저장소는 목이다(올린 키만 기억한다).
describe('고객지원 문의하기 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const storage = {
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    downloadUrl: jest.fn().mockResolvedValue('https://signed.example'),
  };

  const n = randomInt(100_000, 999_999);
  let bpCodeId: number;
  let noMenuGroupId: number;
  let platformAdminId: number;
  let authorId: number;
  let colleagueId: number;
  let noMenuAdminId: number;
  const adminIds = () => [
    platformAdminId,
    authorId,
    colleagueId,
    noMenuAdminId,
  ];

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
        tradeName: '문의하기 테스트 BP',
      },
    }));
    // 문의하기(MN000036) 권한이 없는 그룹
    ({ roleGroupId: noMenuGroupId } = await prisma.roleGroup.create({
      data: {
        roleCode: `BA${n}`,
        bpCodeId,
        roleTypeCode: 'BA',
        name: `문의 권한 없음 ${n}`,
        menus: {
          create: {
            menu: { connect: { menuCode: 'MN000043' } },
            isReadable: true,
          },
        },
      },
    }));
    const platformBp = await prisma.bpCode.findFirstOrThrow({
      where: { bpCode: 'BP000000' },
    });
    const roleGroupId = async (roleCode: string) =>
      (await prisma.roleGroup.findFirstOrThrow({ where: { roleCode } }))
        .roleGroupId;
    const admin = async (
      loginId: string,
      roleTypeCode: 'PA' | 'BA',
      groupId: number,
    ) =>
      (
        await prisma.adminAccount.create({
          data: {
            loginId,
            name: loginId,
            email: `${loginId}@test.invalid`,
            bpCodeId: roleTypeCode === 'PA' ? platformBp.bpCodeId : bpCodeId,
            passwordHash: '!',
            roleTypeCode,
            roleGroupId: groupId,
            joinPathCode: 'PLATFORM_REGISTERED',
            isAllStores: true,
            accountStatusCode: 'ACTIVE',
          },
        })
      ).adminAccountId;
    platformAdminId = await admin(
      `siqpa${n}`,
      'PA',
      await roleGroupId('PM000001'),
    );
    authorId = await admin(`siqba${n}`, 'BA', await roleGroupId('BM000001'));
    colleagueId = await admin(`siqbb${n}`, 'BA', await roleGroupId('BM000001'));
    noMenuAdminId = await admin(`siqbc${n}`, 'BA', noMenuGroupId);
  });

  afterAll(async () => {
    const inquiries = { createdBy: { in: adminIds() } };
    const ids = (
      await prisma.inquiry.findMany({
        where: inquiries,
        select: { inquiryId: true },
      })
    ).map((i) => i.inquiryId);
    // 접수 알림은 플랫폼 운영자 모두(이 테스트 밖의 계정 포함)에게 가므로 알림 단위로 지운다.
    const ours = { relatedType: 'INQUIRY', relatedId: { in: ids } };
    await prisma.notificationRecipient.deleteMany({
      where: { notification: ours },
    });
    await prisma.notification.deleteMany({ where: ours });
    await prisma.inquiryAttachment.deleteMany({
      where: { inquiry: inquiries },
    });
    await prisma.inquiryReply.deleteMany({ where: { inquiry: inquiries } });
    await prisma.inquiry.deleteMany({ where: inquiries });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: adminIds() } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: adminIds() } },
    });
    await prisma.roleGroupMenu.deleteMany({
      where: { roleGroupId: noMenuGroupId },
    });
    await prisma.roleGroup.deleteMany({
      where: { roleGroupId: noMenuGroupId },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  // 가드가 관리자 세션을 확인하므로 실제 admin_sessions 행으로 토큰을 낸다.
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
  const get = async (path: string, as: number) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${await tokenOf(as)}`);
  const post = async (
    fields: Record<string, string>,
    as: number | null = authorId,
    files: [Buffer, string][] = [],
  ) => {
    const req = request(app.getHttpServer()).post('/support-inquiries');
    if (as !== null) req.set('Authorization', `Bearer ${await tokenOf(as)}`);
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    for (const [buffer, name] of files) req.attach('files', buffer, name);
    return req;
  };
  const fields = (title: string) => ({
    inquiryCategoryCode: 'STAFF_LABOR',
    title,
    body: `내용 ${n}`,
  });

  it('토큰이 없으면 401', async () => {
    expect((await post(fields(`a${n}`), null)).status).toBe(401);
  });

  it('문의하기 메뉴 권한이 없으면 등록 · 조회 모두 403', async () => {
    expect((await post(fields(`b${n}`), noMenuAdminId)).status).toBe(403);
    expect((await get('/support-inquiries', noMenuAdminId)).status).toBe(403);
  });

  it('등록하면 소속 BP 로 저장되고 첨부 행 · 운영자 알림이 생긴다', async () => {
    const res = await post(fields(`첨부 ${n}`), authorId, [[PNG, '화면.png']]);
    expect(res.status).toBe(201);
    const { inquiryId } = res.body as { inquiryId: number };
    await expect(
      prisma.inquiry.findUniqueOrThrow({ where: { inquiryId } }),
    ).resolves.toMatchObject({
      createdBy: authorId,
      bpCodeId,
      storeId: null,
      status: 'RECEIVED',
    });
    await expect(
      prisma.inquiryAttachment.findMany({ where: { inquiryId } }),
    ).resolves.toEqual([
      expect.objectContaining({
        fileName: '화면.png',
        fileType: 'PNG',
        sortOrder: 1,
        storageKey: expect.stringMatching(
          new RegExp(`^inquiries/${inquiryId}/`),
        ) as unknown,
      }),
    ]);
    // 알림은 응답 뒤에 만들어진다 — 생길 때까지 기다린다.
    let recipients = 0;
    for (let i = 0; i < 50 && recipients === 0; i++) {
      recipients = await prisma.notificationRecipient.count({
        where: {
          adminAccountId: platformAdminId,
          notification: { relatedType: 'INQUIRY', relatedId: inquiryId },
        },
      });
      if (!recipients) await new Promise((r) => setTimeout(r, 100));
    }
    expect(recipients).toBe(1);
  });

  it('5분 안에 같은 제목 · 내용을 다시 올리면 409', async () => {
    expect((await post(fields(`중복 ${n}`))).status).toBe(201);
    expect((await post(fields(`중복 ${n}`))).status).toBe(409);
    // 다른 관리자는 같은 글이라도 막히지 않는다.
    expect((await post(fields(`중복 ${n}`), colleagueId)).status).toBe(201);
  });

  // 잠금이 없으면 두 요청이 모두 확인을 통과해 둘 다 저장된다. 실제 PostgreSQL 에서만 증명된다 — PGlite 소켓 서버는
  // 연결을 차례로 처리해 잠금 없이도 통과할 수 있다.
  it('같은 문의를 동시에 두 번 올려도 하나만 저장된다', async () => {
    const title = `동시 ${n}`;
    // 토큰을 먼저 낸다 — 세션 발급까지 동시에 하면 PGlite 가 두 연결의 문장을 섞어 가드에서 500 이 난다.
    const token = await tokenOf(authorId);
    const send = () => {
      const req = request(app.getHttpServer())
        .post('/support-inquiries')
        .set('Authorization', `Bearer ${token}`);
      for (const [k, v] of Object.entries(fields(title))) req.field(k, v);
      return req;
    };
    const statuses = (await Promise.all([send(), send()])).map((r) => r.status);
    expect(statuses.sort()).toEqual([201, 409]);
    await expect(
      prisma.inquiry.count({ where: { createdBy: authorId, title } }),
    ).resolves.toBe(1);
  });

  it('사용 중이 아닌 문의 유형 · 이미지/PDF 가 아닌 파일 · 6개는 400', async () => {
    expect(
      (await post({ ...fields(`c${n}`), inquiryCategoryCode: 'NOPE' })).status,
    ).toBe(400);
    expect(
      (await post(fields(`d${n}`), authorId, [[GIF, 'x.png']])).status,
    ).toBe(400);
    const six = Array.from({ length: 6 }, (_, i): [Buffer, string] => [
      PNG,
      `${i}.png`,
    ]);
    expect((await post(fields(`e${n}`), authorId, six)).status).toBe(400);
    await expect(
      prisma.inquiry.count({
        where: { title: { in: [`c${n}`, `d${n}`, `e${n}`] } },
      }),
    ).resolves.toBe(0);
  });

  it('목록 · 상세는 본인 문의만 — 같은 BP 동료의 문의는 404', async () => {
    const mine = await prisma.inquiry.create({
      data: {
        createdBy: authorId,
        bpCodeId,
        inquiryCategoryCode: 'ETC',
        title: `내 것 ${n}`,
        body: 'b',
      },
    });
    const theirs = await prisma.inquiry.create({
      data: {
        createdBy: colleagueId,
        bpCodeId,
        inquiryCategoryCode: 'ETC',
        title: `동료 것 ${n}`,
        body: 'b',
      },
    });
    const list = await get(`/support-inquiries?pageSize=200`, authorId);
    expect(list.status).toBe(200);
    const ids = (list.body as { items: { inquiryId: number }[] }).items.map(
      (i) => i.inquiryId,
    );
    expect(ids).toContain(mine.inquiryId);
    expect(ids).not.toContain(theirs.inquiryId);
    expect(
      (await get(`/support-inquiries/${theirs.inquiryId}`, authorId)).status,
    ).toBe(404);
  });

  it('고친 답변은 마지막 내용과 수정 시각만 — 답변한 운영자는 보이지 않는다', async () => {
    const { inquiryId } = await prisma.inquiry.create({
      data: {
        createdBy: authorId,
        bpCodeId,
        inquiryCategoryCode: 'ETC',
        title: `답변 ${n}`,
        body: 'b',
        status: 'ANSWERED',
      },
    });
    await prisma.inquiryReply.createMany({
      data: [
        {
          inquiryId,
          body: '처음',
          repliedBy: platformAdminId,
          repliedAt: new Date('2026-10-01T00:00:00Z'),
        },
        {
          inquiryId,
          body: '고침',
          repliedBy: platformAdminId,
          repliedAt: new Date('2026-10-02T00:00:00Z'),
        },
      ],
    });
    const res = await get(`/support-inquiries/${inquiryId}`, authorId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      repliedAt: '2026-10-01T00:00:00.000Z',
      reply: {
        body: '고침',
        repliedAt: '2026-10-01T00:00:00.000Z',
        editedAt: '2026-10-02T00:00:00.000Z',
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/repliedBy|internalMemo/);
  });

  it('첨부 내려받기 주소는 본인 문의에서만', async () => {
    const res = await post(fields(`받기 ${n}`), authorId, [[PNG, 'a.png']]);
    const { inquiryId } = res.body as { inquiryId: number };
    const [{ inquiryAttachmentId }] = await prisma.inquiryAttachment.findMany({
      where: { inquiryId },
    });
    const path = `/support-inquiries/${inquiryId}/attachments/${inquiryAttachmentId}/download-url`;
    const own = await get(path, authorId);
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ url: 'https://signed.example' });
    expect((await get(path, colleagueId)).status).toBe(404);
  });
});
