import { randomInt } from 'node:crypto';
import { HttpException, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  BizppurioClient,
  BizppurioError,
} from './../src/alimtalk/bizppurio.client';
import { fakeBizppurio } from './fake-alimtalk';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AuthSessionService } from '../src/auth-session/auth-session.service';
import { ContractExpiryService } from '../src/contracts/contract-expiry.service';
import { ContractSendService } from '../src/contracts/contract-send.service';
import { ContractsService } from '../src/contracts/contracts.service';
import { CreateContractDto } from '../src/contracts/dto/create-contract.dto';
import { OPTIONAL_MAIL_SERVICE } from '../src/mail/mail.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AffiliationRequestsService } from '../src/staff-signup/affiliation-requests.service';

// 소속 추가 확인 요청(WHALEERP-130, 2026-10-26 재영)을 실제 DB 로 확인한다 — 저장하면 발송 대기 · 요청(초대) · 알림톡 · 메일,
// 수락하면 계정을 잇고 서명 대기(날인 기한은 수락부터), 거절하면 요청 · 계약을 거절 · 거부로 닫고 관리자 운영 알림, 답이 없으면
// 요청만 만료되고 계약은 발송 대기로 남아 재발송이 새 요청을 보낸다. 바깥 발송(비즈뿌리오 · SMTP)만 가짜다.
describe('소속 추가 확인 요청 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let contracts: ContractsService;
  let send: ContractSendService;
  let expiry: ContractExpiryService;
  let requests: AffiliationRequestsService;
  const bizppurio = fakeBizppurio();
  const mail = { send: jest.fn().mockResolvedValue({}) };

  let storeId: number;
  let adminId: number;
  const n = randomInt(100_000, 999_999);
  let seq = 0;
  const nextPhone = () => `012${n}${String(seq++).padStart(2, '0')}`;
  /** 하루 배치 기준 — 다른 스위트의 데이터를 건드리지 않게 옛 날짜로 돌린다(contract-status 와 같다) */
  const NOW = new Date('2000-06-01T00:00:00Z');

  const dto = (phone: string): CreateContractDto => ({
    name: '남도현',
    phone,
    birthDate: '1998-07-12',
    storeId,
    jobTitle: '바리스타',
    employmentType: 'PART_TIME',
    contractMethod: 'ELECTRONIC',
    startDate: '2026-11-01',
    wageAmount: 11200,
    workDays: [{ weekday: 'MON', startTime: '10:00', endTime: '16:00' }],
    payMonth: 'NEXT_MONTH',
    payDay: 10,
    isHealthPensionInsured: true,
    isEmploymentInjuryInsured: true,
  });

  /** 이미 가입한 직원(다른 점포 소속)의 계정 */
  const account = async (phone: string) =>
    (
      await prisma.account.create({
        data: {
          email: `affil-${n}-${phone}@test.invalid`,
          passwordHash: '!',
          realName: '남도현',
          birthDate: new Date('1998-07-12'),
          phone,
          gender: 'MALE',
          status: 'JOINED',
        },
        select: { accountId: true },
      })
    ).accountId;

  /** 계정이 있는 번호로 저장한 근로계약 */
  const requested = async () => {
    const phone = nextPhone();
    const accountId = await account(phone);
    const saved = await contracts.create(dto(phone), adminId);
    const invitation = await prisma.invitation.findFirstOrThrow({
      where: { staffMemberId: saved.staffMemberId, status: 'SENT' },
      select: { invitationId: true },
    });
    return { phone, accountId, ...saved, ...invitation };
  };
  const contractOf = (contractId: number) =>
    prisma.contract.findUniqueOrThrow({
      where: { contractId },
      select: {
        status: true,
        signDeadlineAt: true,
        rejectReason: true,
        contractStatusHistories: {
          orderBy: { contractStatusHistoryId: 'asc' },
          select: { fromStatus: true, toStatus: true, actor: true },
        },
      },
    });
  const codeOf = (e: unknown) =>
    ((e as HttpException).getResponse() as { code?: string }).code;

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BizppurioClient)
      .useValue(bizppurio)
      .overrideProvider(OPTIONAL_MAIL_SERVICE)
      .useValue(mail)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    contracts = app.get(ContractsService);
    send = app.get(ContractSendService);
    expiry = app.get(ContractExpiryService);
    requests = app.get(AffiliationRequestsService);

    const { bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${String((n + 600_000) % 1_000_000).padStart(6, '0')}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '소속 추가 테스트 BP',
      },
    });
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${String((n + 600_000) % 1_000_000).padStart(6, '0')}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '소속 추가 점포',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `aff${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    bizppurio.sendMessage.mockClear();
    mail.send.mockClear();
  });

  it('계정이 있는 번호로 저장하면 발송 대기 · 날인 기한 없이 요청(30일)을 만들고 알림톡(대체 문자) · 메일을 보낸다', async () => {
    const r = await requested();
    expect(r).toMatchObject({
      status: 'PENDING_SEND',
      draftAction: 'AFFILIATION_CONFIRM',
    });
    const c = await contractOf(r.contractId);
    expect(c.signDeadlineAt).toBeNull();
    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { invitationId: r.invitationId },
    });
    expect(invitation).toMatchObject({
      invitationType: 'AFFILIATION_CONFIRM',
      channel: 'ALIMTALK',
      invitationToken: null,
      invitationCodeHash: null,
    });
    const record = await prisma.staffMember.findUniqueOrThrow({
      where: { staffMemberId: r.staffMemberId },
      select: { joinStatus: true, candidateAccountId: true, accountId: true },
    });
    expect(record).toEqual({
      joinStatus: 'INVITED',
      candidateAccountId: r.accountId,
      accountId: null,
    });
    // 알림톡은 DB 템플릿으로 렌더해 나간다 — 카카오 템플릿 등록 전이라 대체 문자(본문 + 링크)도 붙는다
    expect(bizppurio.sendMessage).toHaveBeenCalledTimes(1);
    const [message] = bizppurio.sendMessage.mock.calls[0] as [
      { content: { at: { templatecode: string; message: string } } },
    ];
    expect(message.content.at.templatecode).toBe('WHALE_AFFILIATION_01');
    expect(message.content.at.message).toContain(
      '소속 추가 테스트 BP 소속 추가 점포에서 소속 추가를 요청했습니다.',
    );
    expect(message.content.at.message).toContain('고용 형태: 파트타이머');
    expect(mail.send).toHaveBeenCalledWith({
      templateCode: 'EMAIL_STAFF_AFFILIATION_REQUEST',
      to: `affil-${n}-${r.phone}@test.invalid`,
      variables: expect.objectContaining({
        근무지: '소속 추가 점포',
        링크: 'https://staff.e2e.test/affiliations',
      }) as unknown,
    });
    // 직원 앱의 요청 목록에 보인다
    expect(await requests.list(r.accountId)).toEqual([
      expect.objectContaining({
        invitationId: r.invitationId,
        invitationType: 'AFFILIATION_CONFIRM',
        storeName: '소속 추가 점포',
        bpName: '소속 추가 테스트 BP',
        employmentType: 'PART_TIME',
        employmentTypeLabel: '파트타이머',
        asksHqSharingConsent: false,
      }),
    ]);
  });

  it('입력한 이름이 그 번호 계정의 실명과 다르면 요청 · 알림톡은 입력한 대로 보내고 메일은 보내지 않는다 — 받지 못하면 관리자가 유선으로 확인(WHALEERP-140)', async () => {
    const phone = nextPhone();
    const accountId = await account(phone);
    const saved = await contracts.create(
      { ...dto(phone), name: '김철수' },
      adminId,
    );
    expect(saved).toMatchObject({
      status: 'PENDING_SEND',
      draftAction: 'AFFILIATION_CONFIRM',
    });
    expect(bizppurio.sendMessage).toHaveBeenCalledTimes(1);
    expect(mail.send).not.toHaveBeenCalled();
    // 이름이 달라 그 계정 앱에도 보이지 않는다(#196) — 관리자가 근로자 정보에서 이름을 바로잡으면 다시 보낸다
    expect(await requests.list(accountId)).toEqual([]);
  });

  it('수락하면 계정을 잇고 서명 대기로 넘긴다 — 날인 기한은 수락부터 30일, 날인 요청 직원 알림', async () => {
    const r = await requested();
    const now = new Date();
    const accepted = await requests.accept(
      r.accountId,
      r.invitationId,
      {},
      now,
    );
    expect(accepted).toEqual({
      staffMemberId: r.staffMemberId,
      storeName: '소속 추가 점포',
      contractIds: [r.contractId],
    });
    const c = await contractOf(r.contractId);
    expect(c.status).toBe('PENDING_SIGNATURE');
    expect(c.signDeadlineAt?.getTime()).toBe(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
    expect(c.contractStatusHistories.at(-1)).toEqual({
      fromStatus: 'PENDING_SEND',
      toStatus: 'PENDING_SIGNATURE',
      actor: 'STAFF',
    });
    expect(
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: r.staffMemberId },
        select: { joinStatus: true, accountId: true, candidateAccountId: true },
      }),
    ).toEqual({
      joinStatus: 'JOINED',
      accountId: r.accountId,
      candidateAccountId: null,
    });
    expect(
      await prisma.notificationRecipient.count({
        where: {
          accountId: r.accountId,
          notification: {
            templateCode: 'PUSH_CONTRACT_SENT',
            relatedId: r.contractId,
          },
        },
      }),
    ).toBe(1);
    // 다시 답하면 409, 목록에서도 빠진다
    expect(
      codeOf(
        await requests
          .accept(r.accountId, r.invitationId, {})
          .catch((e: unknown) => e),
      ),
    ).toBe('AFFILIATION_REQUEST_ANSWERED');
    expect(await requests.list(r.accountId)).toEqual([]);
  });

  it('근로계약서 이름이 계정 이름과 다르면(번호를 넘겨받은 다른 사람일 수 있음) 그 계정에 요청이 보이지 않고 답하지 못한다 — 이름을 바로잡으면 보인다(WHALEERP-140)', async () => {
    const r = await requested();
    await prisma.staffMember.update({
      where: { staffMemberId: r.staffMemberId },
      data: { name: '김철수' },
    });
    expect(await requests.list(r.accountId)).toEqual([]);
    const notFound = expect.objectContaining({
      response: expect.objectContaining({
        code: 'AFFILIATION_REQUEST_NOT_FOUND',
      }) as unknown,
    }) as unknown;
    await expect(
      requests.accept(r.accountId, r.invitationId, {}),
    ).rejects.toEqual(notFound);
    await expect(
      requests.reject(r.accountId, r.invitationId, {}),
    ).rejects.toEqual(notFound);
    expect((await contractOf(r.contractId)).status).toBe('PENDING_SEND');
    // 공백만 다른 같은 이름이면 그 계정 요청이다(날인 본인 대조와 같은 기준)
    await prisma.staffMember.update({
      where: { staffMemberId: r.staffMemberId },
      data: { name: '남 도현' },
    });
    expect(
      (await requests.list(r.accountId)).map((i) => i.invitationId),
    ).toEqual([r.invitationId]);
  });

  it('거절하면 요청 · 함께 온 계약을 거절 · 거부로 닫고 같은 사유를 남긴다 — 레코드는 두고 초안을 쓴 관리자에게 알린다', async () => {
    const r = await requested();
    await requests.reject(r.accountId, r.invitationId, {
      reason: '다른 곳에서 일해요',
    });
    const c = await contractOf(r.contractId);
    expect(c).toMatchObject({
      status: 'REJECTED',
      rejectReason: '다른 곳에서 일해요',
    });
    expect(c.contractStatusHistories.at(-1)).toEqual({
      fromStatus: 'PENDING_SEND',
      toStatus: 'REJECTED',
      actor: 'STAFF',
    });
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { invitationId: r.invitationId },
        select: { status: true, rejectReason: true },
      }),
    ).toEqual({ status: 'REJECTED', rejectReason: '다른 곳에서 일해요' });
    expect(
      await prisma.staffMember.findUniqueOrThrow({
        where: { staffMemberId: r.staffMemberId },
        select: { accountId: true, candidateAccountId: true },
      }),
    ).toEqual({ accountId: null, candidateAccountId: r.accountId });
    const notice = await prisma.notification.findFirst({
      where: {
        dedupeKey: `NTF_AFFILIATION_REJECTED:${r.invitationId}`,
      },
      select: {
        title: true,
        relatedType: true,
        relatedId: true,
        notificationRecipients: { select: { adminAccountId: true } },
      },
    });
    expect(notice).toEqual({
      title: '남도현 님이 소속 추가 확인을 거절했습니다',
      relatedType: 'STAFF_MEMBER',
      relatedId: r.staffMemberId,
      notificationRecipients: [{ adminAccountId: adminId }],
    });
    // 남의 요청 · 없는 요청은 404
    const other = await account(nextPhone());
    expect(
      codeOf(
        await requests
          .reject(other, r.invitationId, {})
          .catch((e: unknown) => e),
      ),
    ).toBe('AFFILIATION_REQUEST_NOT_FOUND');
  });

  it('거절한 요청의 계약을 재발송하면 발송 대기로 되살리고 새 요청을 보낸다 — 수락하면 서명 대기(WHALEERP-153 · 130)', async () => {
    const r = await requested();
    await requests.reject(r.accountId, r.invitationId, {});
    expect((await contractOf(r.contractId)).status).toBe('REJECTED');

    bizppurio.sendMessage.mockClear();
    const resent = await send.send(adminId, r.contractId);
    expect(resent).toMatchObject({
      status: 'PENDING_SEND',
      signDeadlineAt: null,
    });
    expect(
      (await contractOf(r.contractId)).contractStatusHistories.at(-1),
    ).toEqual({
      fromStatus: 'REJECTED',
      toStatus: 'PENDING_SEND',
      actor: 'ADMIN',
    });
    expect(bizppurio.sendMessage).toHaveBeenCalledTimes(1);
    const [fresh] = await requests.list(r.accountId);
    expect(fresh.invitationId).not.toBe(r.invitationId);
    await requests.accept(r.accountId, fresh.invitationId, {});
    expect((await contractOf(r.contractId)).status).toBe('PENDING_SIGNATURE');
  });

  it('요청의 고용 형태 · 직무는 레코드가 아니라 함께 온 계약의 값이다 — 재계약처럼 둘이 다를 때(api #164 재리뷰 참고 1)', async () => {
    const r = await requested();
    // 레코드는 지난 계약 조건(정직원 · 홀), 함께 온 계약은 파트타이머 · 바리스타
    await prisma.staffMember.update({
      where: { staffMemberId: r.staffMemberId },
      data: { employmentType: 'FULL_TIME', jobTitle: '홀' },
    });
    // 뒤에 만든(id 가 더 큰) 종료 계약은 고르지 않는다 — 진행 중(발송 대기 · 서명 대기) 계약만 본다
    await prisma.contract.create({
      data: {
        storeId,
        staffMemberId: r.staffMemberId,
        status: 'ENDED',
        employmentType: 'FULL_TIME',
        jobTitle: '매니저',
        createdBy: adminId,
      },
    });
    const [item] = await requests.list(r.accountId);
    expect(item).toMatchObject({
      employmentType: 'PART_TIME',
      jobTitle: '바리스타',
    });
  });

  it('답하지 않아 기한이 지나면 요청만 만료되고 계약은 발송 대기로 남는다 — 재발송이 새 요청을 보낸다', async () => {
    const r = await requested();
    // 이 요청만 하루 배치 기준보다 앞서 끝나게 둔다
    await prisma.invitation.update({
      where: { invitationId: r.invitationId },
      data: { expiresAt: new Date('2000-05-01T00:00:00Z') },
    });
    await prisma.$transaction((tx) => expiry.runDaily(tx, NOW));
    expect(
      (
        await prisma.invitation.findUniqueOrThrow({
          where: { invitationId: r.invitationId },
        })
      ).status,
    ).toBe('EXPIRED');
    expect((await contractOf(r.contractId)).status).toBe('PENDING_SEND');
    expect(await requests.list(r.accountId)).toEqual([]);
    expect(
      codeOf(
        await requests
          .accept(r.accountId, r.invitationId, {})
          .catch((e: unknown) => e),
      ),
    ).toBe('AFFILIATION_REQUEST_ENDED');

    bizppurio.sendMessage.mockClear();
    const resent = await send.send(adminId, r.contractId);
    expect(resent).toMatchObject({
      status: 'PENDING_SEND',
      signDeadlineAt: null,
    });
    expect(bizppurio.sendMessage).toHaveBeenCalledTimes(1);
    const [fresh] = await requests.list(r.accountId);
    expect(fresh.invitationId).not.toBe(r.invitationId);
    // 새 요청으로 수락하면 이어진다
    await requests.accept(r.accountId, fresh.invitationId, {});
    expect((await contractOf(r.contractId)).status).toBe('PENDING_SIGNATURE');
  });

  it('알림톡이 확실히 나가지 않으면 저장을 임시저장으로 되돌리고 요청을 지운다(502 SEND_FAILED)', async () => {
    const phone = nextPhone();
    await account(phone);
    // 비즈뿌리오가 코드로 거절 — 확실히 나가지 않았다
    bizppurio.sendMessage.mockRejectedValueOnce(
      new BizppurioError('거절', 3001, 400),
    );
    const error = await contracts
      .create(dto(phone), adminId)
      .catch((e: unknown) => e);
    const body = (error as HttpException).getResponse() as {
      code: string;
      contractId: number;
      status: string;
    };
    expect(body).toMatchObject({ code: 'SEND_FAILED', status: 'DRAFT' });
    const c = await prisma.contract.findUniqueOrThrow({
      where: { contractId: body.contractId },
      select: {
        status: true,
        staffMemberId: true,
        staffMember: { select: { joinStatus: true, candidateAccountId: true } },
      },
    });
    expect(c.status).toBe('DRAFT');
    expect(c.staffMember.joinStatus).toBe('DRAFT');
    // 후보 계정은 판별이 남긴 값 그대로 — 다시 보내면 이어진다
    expect(c.staffMember.candidateAccountId).not.toBeNull();
    expect(
      await prisma.invitation.count({
        where: { staffMemberId: c.staffMemberId },
      }),
    ).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  describe('HTTP — /me/affiliation-requests', () => {
    const accountToken = async (accountId: number) => {
      const session = await app
        .get(AuthSessionService)
        .issue({ accountId, deviceIdentifier: `affil-e2e-${accountId}` });
      return app.get(JwtService).signAsync({
        sub: accountId,
        type: 'account',
        email: 'staff@test.invalid',
        typ: 'access',
        sid: session.authSessionId,
      });
    };
    const adminToken = async () =>
      (
        await app
          .get(AdminSessionService)
          .issue({ adminAccountId: adminId }, (sid) =>
            app.get(JwtService).signAsync({
              sub: adminId,
              type: 'admin',
              loginId: `aff${n}`,
              typ: 'access',
              sid,
            }),
          )
      ).accessToken;
    const http = () => request(app.getHttpServer());

    it('관리자 토큰은 403, 경로 id 가 정수가 아니면 404, 거절 사유가 500자를 넘으면 400 — 아무것도 바꾸지 않는다', async () => {
      const r = await requested();
      const admin = await adminToken();
      await http()
        .get('/me/affiliation-requests')
        .set('Authorization', `Bearer ${admin}`)
        .expect(403);
      await http()
        .post(`/me/affiliation-requests/${r.invitationId}/accept`)
        .set('Authorization', `Bearer ${admin}`)
        .send({})
        .expect(403);

      const auth = `Bearer ${await accountToken(r.accountId)}`;
      await http()
        .post('/me/affiliation-requests/abc/accept')
        .set('Authorization', auth)
        .send({})
        .expect(404);
      const long = await http()
        .post(`/me/affiliation-requests/${r.invitationId}/reject`)
        .set('Authorization', auth)
        .send({ reason: 'ㄱ'.repeat(501) })
        .expect(400);
      expect(JSON.stringify(long.body)).toContain('500자 이하');
      expect((await contractOf(r.contractId)).status).toBe('PENDING_SEND');

      // 목록은 요청 제한(10분 10번)에 묶이지 않는다 — 앱이 열 때마다 읽는다
      for (let i = 0; i < 11; i++)
        await http()
          .get('/me/affiliation-requests')
          .set('Authorization', auth)
          .expect(200);
      // 앞뒤 공백은 지운 뒤 센다 — 500자 + 공백은 받는다(근로계약서 거부와 같다)
      await http()
        .post(`/me/affiliation-requests/${r.invitationId}/reject`)
        .set('Authorization', auth)
        .send({ reason: ` ${'ㄱ'.repeat(500)} ` })
        .expect(204);
      expect(await contractOf(r.contractId)).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'ㄱ'.repeat(500),
      });
    });
  });
});
