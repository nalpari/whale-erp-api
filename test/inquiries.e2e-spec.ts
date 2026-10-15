import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 문의사항 · 도입문의 처리(WHALEERP-274)를 실제 DB 로 확인한다. 같은 문의에 동시에 답변할 때 한쪽만 409 가 되는
// 것은 PostgreSQL 의 행 잠금 뒤 재평가에 달려 있어, 목으로는 가정만 할 수 있고 여기서만 증명된다.
describe('문의사항 · 도입문의 처리 (e2e, DB)', () => {
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
    await app.init();
    prisma = app.get(PrismaService);

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'INACTIVE',
        tradeName: '문의 테스트 BP',
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
            email: `${loginId}@test.invalid`,
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
    platformAdminId = await admin(`iqpa${n}`, 'PA');
    bpAdminId = await admin(`iqba${n}`, 'BA');
  });

  afterAll(async () => {
    const inquiries = { createdBy: bpAdminId };
    const ids = (
      await prisma.inquiry.findMany({
        where: inquiries,
        select: { inquiryId: true },
      })
    ).map((i) => i.inquiryId);
    const leadIds = (
      await prisma.lead.findMany({
        where: { email: `lead${n}@test.invalid` },
        select: { leadId: true },
      })
    ).map((l) => l.leadId);
    // 도입문의 알림은 플랫폼 운영자 모두(이 테스트 밖의 계정 포함)에게 가므로 알림 단위로 지운다.
    const ours = {
      OR: [
        { relatedType: 'INQUIRY', relatedId: { in: ids } },
        { relatedType: 'LEAD', relatedId: { in: leadIds } },
      ],
    };
    await prisma.notificationRecipient.deleteMany({
      where: { notification: ours },
    });
    await prisma.notification.deleteMany({ where: ours });
    await prisma.inquiryReply.deleteMany({ where: { inquiry: inquiries } });
    await prisma.inquiry.deleteMany({ where: inquiries });
    await prisma.lead.deleteMany({ where: { email: `lead${n}@test.invalid` } });
    await prisma.adminSession.deleteMany({
      where: { adminAccountId: { in: [platformAdminId, bpAdminId] } },
    });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: [platformAdminId, bpAdminId] } },
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
  const call = async (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    body?: object,
    as: number | null = platformAdminId,
  ) => {
    const req = request(app.getHttpServer())[method](path);
    if (as !== null) req.set('Authorization', `Bearer ${await tokenOf(as)}`);
    return body ? req.send(body) : req;
  };
  const newInquiry = () =>
    prisma.inquiry.create({
      data: {
        createdBy: bpAdminId,
        bpCodeId,
        inquiryCategoryCode: 'ETC',
        title: `문의 ${n}`,
        body: '내용',
      },
    });
  const newLead = () =>
    prisma.lead.create({
      data: {
        contactName: '김도윤',
        industryCode: 'CAFE',
        phone: '0212345678',
        email: `lead${n}@test.invalid`,
        interests: ['STORE_OPERATION'],
        body: '도입 비용',
        privacyAgreedAt: new Date(),
      },
    });
  const iso = (d: Date) => d.toISOString();
  // 알림은 응답 뒤에 만들어진다(응답이 발송을 기다리지 않는다). 읽기 전에 먼저 쉰다 — 뒤에서 도는 알림과 동시에
  // DB 를 쓰면 연결을 하나만 받는 PGlite 소켓 서버가 연결을 끊는다(실제 PostgreSQL 은 괜찮다).
  const eventually = async <T>(
    read: () => Promise<T>,
    done: (v: T) => boolean,
  ) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const value = await read();
      if (done(value)) return value;
    }
    return read();
  };
  const notificationsOf = (inquiryId: number) =>
    prisma.notification.findMany({
      where: { relatedType: 'INQUIRY', relatedId: inquiryId },
      include: { notificationRecipients: true },
    });

  describe('문의사항', () => {
    it('처리중으로 바꾸면 바꾼 운영자 · 시각이 남고, 두 번째는 409', async () => {
      const { inquiryId } = await newInquiry();
      const res = await call('post', `/inquiries/${inquiryId}/processing`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ inquiryId, status: 'IN_PROGRESS' });
      const row = await prisma.inquiry.findUniqueOrThrow({
        where: { inquiryId },
      });
      expect(row.processingStartedBy).toBe(platformAdminId);
      expect(row.processingStartedAt).toBeInstanceOf(Date);

      const again = await call('post', `/inquiries/${inquiryId}/processing`);
      expect(again.status).toBe(409);
    });

    it('첫 답변은 답변 완료로 바꾸고 등록자에게 운영 알림을 한 번 만든다. 고칠 때는 행만 더한다', async () => {
      const inquiry = await newInquiry();
      const { inquiryId } = inquiry;
      const first = await call('post', `/inquiries/${inquiryId}/replies`, {
        body: '첫 답변',
        updatedAt: iso(inquiry.updatedAt),
      });
      expect(first.status).toBe(201);
      const answered = first.body as { status: string; updatedAt: string };
      expect(answered.status).toBe('ANSWERED');
      const notifications = await eventually(
        () => notificationsOf(inquiryId),
        (rows) => rows.length > 0,
      );

      const edit = await call('post', `/inquiries/${inquiryId}/replies`, {
        body: '고친 답변',
        updatedAt: answered.updatedAt,
      });
      expect(edit.status).toBe(201);

      const replies = await prisma.inquiryReply.findMany({
        where: { inquiryId },
        orderBy: { inquiryReplyId: 'asc' },
      });
      expect(replies.map((r) => r.body)).toEqual(['첫 답변', '고친 답변']);
      expect(replies.every((r) => r.repliedBy === platformAdminId)).toBe(true);

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        templateCode: 'NTF_INQUIRY_ANSWERED',
        link: `/support/inquiries/${inquiryId}`,
      });
      expect(
        notifications[0].notificationRecipients.map((r) => r.adminAccountId),
      ).toEqual([bpAdminId]);
      // 고쳐도 알림은 늘지 않는다(CNT-17). 뒤에서 돌 일이 있다면 끝날 때까지 기다린 뒤 센다.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await notificationsOf(inquiryId)).toHaveLength(1);
    });

    it('같은 updatedAt 으로 동시에 답변하면 하나만 저장되고 나머지는 409', async () => {
      const inquiry = await newInquiry();
      const body = (text: string) => ({
        body: text,
        updatedAt: iso(inquiry.updatedAt),
      });
      const results = await Promise.all([
        call('post', `/inquiries/${inquiry.inquiryId}/replies`, body('A')),
        call('post', `/inquiries/${inquiry.inquiryId}/replies`, body('B')),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await prisma.inquiryReply.count({
          where: { inquiryId: inquiry.inquiryId },
        }),
      ).toBe(1);
    });

    it('내부 메모는 저장되고, 옛 updatedAt 이면 409', async () => {
      const inquiry = await newInquiry();
      const saved = await call(
        'put',
        `/inquiries/${inquiry.inquiryId}/internal-memo`,
        { internalMemo: '전화 확인', updatedAt: iso(inquiry.updatedAt) },
      );
      expect(saved.status).toBe(200);
      const stale = await call(
        'put',
        `/inquiries/${inquiry.inquiryId}/internal-memo`,
        { internalMemo: '덮어쓰기', updatedAt: iso(inquiry.updatedAt) },
      );
      expect(stale.status).toBe(409);
      const row = await prisma.inquiry.findUniqueOrThrow({
        where: { inquiryId: inquiry.inquiryId },
      });
      expect(row.internalMemo).toBe('전화 확인');
    });

    it('다른 운영자가 처리중으로 바꾼 뒤 옛 updatedAt 으로 답변하면 409', async () => {
      const inquiry = await newInquiry();
      expect(
        (await call('post', `/inquiries/${inquiry.inquiryId}/processing`))
          .status,
      ).toBe(200);
      const stale = await call(
        'post',
        `/inquiries/${inquiry.inquiryId}/replies`,
        { body: '답변', updatedAt: iso(inquiry.updatedAt) },
      );
      expect(stale.status).toBe(409);
    });

    it('BP 관리자는 403, 없는 문의는 404', async () => {
      const { inquiryId } = await newInquiry();
      expect(
        (
          await call(
            'post',
            `/inquiries/${inquiryId}/processing`,
            undefined,
            bpAdminId,
          )
        ).status,
      ).toBe(403);
      expect(
        (await call('post', '/inquiries/2147483647/processing')).status,
      ).toBe(404);
    });
  });

  describe('도입문의', () => {
    it('관리자 경로는 공개가 아니다 — 토큰 없이 401', async () => {
      const { leadId } = await newLead();
      expect(
        (await call('post', `/leads/${leadId}/processing`, undefined, null))
          .status,
      ).toBe(401);
    });

    it('처리중 → 답변하면 답변자 · 시각 · 상담 완료일이 남고, 고쳐도 상담 완료일은 그대로다', async () => {
      const lead = await newLead();
      const { leadId } = lead;
      expect((await call('post', `/leads/${leadId}/processing`)).status).toBe(
        200,
      );
      const leadNotifications = () =>
        prisma.notification.findMany({
          where: { relatedType: 'LEAD', relatedId: leadId },
          orderBy: { notificationId: 'asc' },
        });
      // 처리 상태가 바뀌면 플랫폼 운영자에게 NTF_LEAD_ANSWERED 가 간다(뒤에서 만들어지므로 기다린다).
      expect(
        (await eventually(leadNotifications, (rows) => rows.length === 1)).map(
          (r) => r.dedupeKey,
        ),
      ).toEqual([`NTF_LEAD_ANSWERED:${leadId}:IN_PROGRESS`]);
      const processing = await prisma.lead.findUniqueOrThrow({
        where: { leadId },
      });
      expect(processing.processingStartedBy).toBe(platformAdminId);

      const first = await call('put', `/leads/${leadId}/reply`, {
        reply: '연락드렸습니다',
        updatedAt: iso(processing.updatedAt),
      });
      expect(first.status).toBe(200);
      expect(
        (await eventually(leadNotifications, (rows) => rows.length === 2)).map(
          (r) => r.dedupeKey,
        ),
      ).toEqual([
        `NTF_LEAD_ANSWERED:${leadId}:IN_PROGRESS`,
        `NTF_LEAD_ANSWERED:${leadId}:ANSWERED`,
      ]);
      const answered = await prisma.lead.findUniqueOrThrow({
        where: { leadId },
      });
      expect(answered).toMatchObject({
        status: 'ANSWERED',
        reply: '연락드렸습니다',
        repliedBy: platformAdminId,
      });
      expect(answered.consultedDate).toBeInstanceOf(Date);

      // 상담 완료일을 지난 날로 돌려 두고 고친다 — 고칠 때 오늘로 다시 쓰면 1년 파기 기준이 밀린다.
      const past = new Date('2026-01-02T00:00:00Z');
      const moved = await prisma.lead.update({
        where: { leadId },
        data: { consultedDate: past },
      });
      const edit = await call('put', `/leads/${leadId}/reply`, {
        reply: '다시 연락드렸습니다',
        updatedAt: iso(moved.updatedAt),
      });
      expect(edit.status).toBe(200);
      const edited = await prisma.lead.findUniqueOrThrow({
        where: { leadId },
      });
      expect(edited.reply).toBe('다시 연락드렸습니다');
      expect(edited.consultedDate).toEqual(past);
      // 답변을 고쳐도(상태가 그대로) 알림은 늘지 않는다.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await leadNotifications()).toHaveLength(2);
    });

    it('내부 메모를 옛 updatedAt 으로 저장하면 409 이고 앞의 메모가 남는다', async () => {
      const lead = await newLead();
      const first = await call('put', `/leads/${lead.leadId}/internal-memo`, {
        internalMemo: '먼저 쓴 메모',
        updatedAt: iso(lead.updatedAt),
      });
      expect(first.status).toBe(200);
      const stale = await call('put', `/leads/${lead.leadId}/internal-memo`, {
        internalMemo: '덮어쓰기',
        updatedAt: iso(lead.updatedAt),
      });
      expect(stale.status).toBe(409);
      const row = await prisma.lead.findUniqueOrThrow({
        where: { leadId: lead.leadId },
      });
      expect(row.internalMemo).toBe('먼저 쓴 메모');
    });

    it('옛 updatedAt 으로 답변하면 409', async () => {
      const lead = await newLead();
      await call('put', `/leads/${lead.leadId}/internal-memo`, {
        internalMemo: '메모',
        updatedAt: iso(lead.updatedAt),
      });
      const stale = await call('put', `/leads/${lead.leadId}/reply`, {
        reply: '답변',
        updatedAt: iso(lead.updatedAt),
      });
      expect(stale.status).toBe(409);
    });

    // CNT-11: 상담하지 않은 건만 운영자가 지운다. 개인정보 파기라 행이 남지 않는다.
    it('상담 완료일이 없으면 지워 행이 사라지고, 상담을 마쳤으면 409 로 남는다', async () => {
      const { leadId } = await newLead();
      expect(
        (await call('delete', `/leads/${leadId}`, undefined, bpAdminId)).status,
      ).toBe(403);
      expect((await call('delete', `/leads/${leadId}`)).status).toBe(204);
      expect(await prisma.lead.findUnique({ where: { leadId } })).toBeNull();
      expect((await call('delete', `/leads/${leadId}`)).status).toBe(404);

      const consulted = await newLead();
      await prisma.lead.update({
        where: { leadId: consulted.leadId },
        data: { consultedDate: new Date() },
      });
      expect((await call('delete', `/leads/${consulted.leadId}`)).status).toBe(
        409,
      );
      expect(
        await prisma.lead.findUnique({ where: { leadId: consulted.leadId } }),
      ).not.toBeNull();
    });
  });

  describe('목록 · 상세 (#332)', () => {
    type Page<T> = { items: T[]; total: number };

    it('문의사항 목록은 제목 · 보낸 곳 · 답변 상태로 거르고 보낸 곳 이름을 준다', async () => {
      const { inquiryId } = await newInquiry();
      // 쪽 하나에 다 들도록 pageSize 를 최대로 둔다 — 이 실행의 문의가 기본 20건을 넘을 수 있다.
      const list = (query: string) =>
        call('get', `/inquiries?title=${n}&pageSize=200&${query}`);
      const fromUs = 'sender=' + encodeURIComponent('문의 테스트');

      const all = await list(fromUs);
      expect(all.status).toBe(200);
      const page = all.body as Page<{ inquiryId: number }>;
      expect(page.items.map((i) => i.inquiryId)).toContain(inquiryId);
      expect(page.items[0]).toMatchObject({
        bpName: '문의 테스트 BP',
        storeName: null,
        senderName: 'BP관리자',
      });
      expect(page.total).toBe(page.items.length);

      const nobody = await list('sender=' + encodeURIComponent(`없는곳${n}`));
      expect(nobody.body).toEqual({ items: [], total: 0 });

      // 같은 실행의 다른 테스트가 답변한 문의도 제목에 걸린다 — 갈래의 합과 이 문의가 든 쪽만 본다.
      const waiting = (await list(`${fromUs}&answerStatus=WAITING`))
        .body as Page<{ inquiryId: number }>;
      const answered = (await list(`${fromUs}&answerStatus=ANSWERED`))
        .body as Page<{ inquiryId: number }>;
      expect(waiting.items.map((i) => i.inquiryId)).toContain(inquiryId);
      expect(answered.items.map((i) => i.inquiryId)).not.toContain(inquiryId);
      expect(waiting.total + answered.total).toBe(page.total);

      expect((await list('answerStatus=RECEIVED')).status).toBe(400);
    });

    it('문의사항 상세는 사람 이름 · 답변 이력을 준다', async () => {
      // 답변 API 를 거치지 않고 넣는다 — 응답 뒤에 도는 알림이 다음 읽기와 겹치면 PGlite 소켓 서버가 연결을 끊는다.
      const inquiry = await newInquiry();
      await prisma.inquiry.update({
        where: { inquiryId: inquiry.inquiryId },
        data: { status: 'ANSWERED' },
      });
      await prisma.inquiryReply.create({
        data: {
          inquiryId: inquiry.inquiryId,
          body: '답변',
          repliedBy: platformAdminId,
        },
      });
      const res = await call('get', `/inquiries/${inquiry.inquiryId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        inquiryId: inquiry.inquiryId,
        status: 'ANSWERED',
        bpName: '문의 테스트 BP',
        senderName: 'BP관리자',
        senderRoleTypeCode: 'BA',
        replies: [{ body: '답변', repliedByName: '운영자' }],
        attachments: [],
      });
    });

    it('도입문의 목록 · 상세', async () => {
      const { leadId } = await newLead();
      const list = await call(
        'get',
        '/leads?answerStatus=WAITING&pageSize=200',
      );
      expect(list.status).toBe(200);
      expect(
        (list.body as Page<{ leadId: number }>).items.map((l) => l.leadId),
      ).toContain(leadId);

      const res = await call('get', `/leads/${leadId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        leadId,
        contactName: '김도윤',
        email: `lead${n}@test.invalid`,
        interests: ['STORE_OPERATION'],
        status: 'RECEIVED',
        reply: null,
        repliedByName: null,
        consultedDate: null,
        marketingAgreedAt: null,
      });
    });

    it.each(['/inquiries', '/inquiries/1', '/leads', '/leads/1'])(
      '%s 는 토큰이 없으면 401, 플랫폼 관리자가 아니면 403',
      async (path) => {
        expect((await call('get', path, undefined, null)).status).toBe(401);
        expect((await call('get', path, undefined, bpAdminId)).status).toBe(
          403,
        );
      },
    );

    it.each(['/inquiries/2147483648', '/leads/0', '/inquiries/2147483647'])(
      '%s 는 404',
      async (path) => {
        expect((await call('get', path)).status).toBe(404);
      },
    );
  });
});
