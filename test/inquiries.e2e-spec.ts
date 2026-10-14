import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
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
    await prisma.notificationRecipient.deleteMany({
      where: { adminAccountId: bpAdminId },
    });
    await prisma.notification.deleteMany({
      where: { relatedType: 'INQUIRY', relatedId: { in: ids } },
    });
    await prisma.inquiryReply.deleteMany({ where: { inquiry: inquiries } });
    await prisma.inquiry.deleteMany({ where: inquiries });
    await prisma.lead.deleteMany({ where: { email: `lead${n}@test.invalid` } });
    await prisma.adminAccount.deleteMany({
      where: { adminAccountId: { in: [platformAdminId, bpAdminId] } },
    });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const tokenOf = (sub: number) =>
    app.get(JwtService).signAsync({
      sub,
      type: 'admin',
      email: 'inquiries@test.invalid',
      typ: 'access',
    });
  const call = async (
    method: 'post' | 'put',
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

      const notifications = await prisma.notification.findMany({
        where: { relatedType: 'INQUIRY', relatedId: inquiryId },
        include: { notificationRecipients: true },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        templateCode: 'NTF_INQUIRY_ANSWERED',
        link: `/support/inquiries/${inquiryId}`,
      });
      expect(
        notifications[0].notificationRecipients.map((r) => r.adminAccountId),
      ).toEqual([bpAdminId]);
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
      const processing = await prisma.lead.findUniqueOrThrow({
        where: { leadId },
      });
      expect(processing.processingStartedBy).toBe(platformAdminId);

      const first = await call('put', `/leads/${leadId}/reply`, {
        reply: '연락드렸습니다',
        updatedAt: iso(processing.updatedAt),
      });
      expect(first.status).toBe(200);
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
  });
});
