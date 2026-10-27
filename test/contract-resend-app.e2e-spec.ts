import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminSessionService } from '../src/admin-session/admin-session.service';
import { AlimtalkService } from '../src/alimtalk/alimtalk.service';
import { SEND_VALID_MS } from '../src/contracts/contract-delivery.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { StaffMemberListResponseDto } from '../src/staff-members/dto/staff-member-list.response.dto';

// 가입한 직원의 근로계약 재발송 — 앱 알림(WHALEERP-611)과, 직원 목록 invitation.canResend 가 재발송 api 의 판정과
// 맞는지를 실제 DB 로. 알림 줄 · 날인 기한 · 상태 이력은 목으로는 증명되지 않는다.
describe('근로계약 재발송 — 앱 알림 · 목록 canResend (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let alimtalkSend: jest.SpyInstance;

  const n = randomInt(100_000, 999_999);
  let bpCodeId: number;
  let storeId: number;
  let adminId: number;
  const accountIds: number[] = [];
  const staffIds: number[] = [];
  const ids: Record<string, { staffMemberId: number; contractId: number }> = {};
  const phone = () => `010${randomInt(10_000_000, 99_999_999)}`;

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error(
        'APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다',
      );
    // 유선번호 줄이 설정 503 이 아니라 번호 검사(409)까지 가는 것은 공용 설정(e2e-env.ts)의 앱 주소 · 대체 문자 발신번호 덕이다.
    // 알림톡은 아래에서 가로챈다
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    // 앱 알림 재발송은 알림톡을 보내지 않는다 — 불리면 실패로 드러나게 가로챈다
    alimtalkSend = jest
      .spyOn(app.get(AlimtalkService), 'send')
      .mockRejectedValue(new Error('알림톡을 보내면 안 된다'));

    ({ bpCodeId } = await prisma.bpCode.create({
      data: {
        bpCode: `BP${n}`,
        isPlatform: false,
        accountStatusCode: 'ACTIVE',
        tradeName: '재발송 테스트 BP',
      },
    }));
    ({ storeId } = await prisma.store.create({
      data: {
        storeCode: `ST${n}`,
        bpCodeId,
        storeTypeCode: 'DIRECT',
        name: '모리커피 연남점',
        storeStatusCode: 'OPERATING',
      },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({
      where: { roleCode: 'BM000001' },
    });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `resend${n}`,
        bpCodeId,
        passwordHash: '!',
        roleTypeCode: 'BM',
        roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED',
        isAllStores: true,
        accountStatusCode: 'ACTIVE',
      },
    }));

    const account = async (status: 'JOINED' | 'WITHDRAWN' = 'JOINED') => {
      const p = phone();
      const a = await prisma.account.create({
        data: {
          email: `resend-${p}@test.invalid`,
          passwordHash: '!',
          realName: '재발송',
          birthDate: new Date('1990-01-01'),
          phone: p,
          status,
        },
      });
      accountIds.push(a.accountId);
      return a;
    };
    // 직원 레코드 + 계약 하나(보낸 지 열흘, 기한 스무 날 남음) + (가입 전이면) 초대 하나
    const staff = async (
      key: string,
      opts: {
        joinStatus: 'INVITED' | 'JOINED';
        contractStatus: 'PENDING_SEND' | 'PENDING_SIGNATURE' | 'SIGNED';
        accountId?: number;
        phone?: string;
        invitation?: {
          invitationType: 'SIGNUP' | 'AFFILIATION_CONFIRM';
          status: 'SENT' | 'ACCEPTED';
        };
        draftAction?: 'SIGNUP_INVITE' | 'AFFILIATION_CONFIRM';
      },
    ) => {
      const s = await prisma.staffMember.create({
        data: {
          storeId,
          accountId: opts.accountId ?? null,
          name: key,
          phone: opts.phone ?? phone(),
          employmentType: 'PART_TIME',
          jobTitle: '홀',
          joinStatus: opts.joinStatus,
        },
      });
      staffIds.push(s.staffMemberId);
      const sentAt = new Date(Date.now() - 10 * 86_400_000);
      const c = await prisma.contract.create({
        data: {
          staffMemberId: s.staffMemberId,
          storeId,
          employmentType: 'PART_TIME',
          contractMethod: 'ELECTRONIC',
          startDate: new Date('2026-11-01'),
          isHealthPensionInsured: false,
          isEmploymentInjuryInsured: false,
          status: opts.contractStatus,
          draftAction: opts.draftAction ?? 'SIGNUP_INVITE',
          sentAt,
          signDeadlineAt: new Date(sentAt.getTime() + SEND_VALID_MS),
          createdBy: adminId,
        },
      });
      if (opts.invitation)
        await prisma.invitation.create({
          data: {
            staffMemberId: s.staffMemberId,
            invitationType: opts.invitation.invitationType,
            invitationToken:
              opts.invitation.invitationType === 'AFFILIATION_CONFIRM'
                ? null
                : `resend-e2e-${n}-${key}`,
            channel: 'ALIMTALK',
            sentAt,
            expiresAt: new Date(sentAt.getTime() + SEND_VALID_MS),
            status: opts.invitation.status,
          },
        });
      ids[key] = { staffMemberId: s.staffMemberId, contractId: c.contractId };
    };

    const joined = await account();
    await staff('joinedSigning', {
      joinStatus: 'JOINED',
      contractStatus: 'PENDING_SIGNATURE',
      accountId: joined.accountId,
      phone: joined.phone,
      invitation: { invitationType: 'SIGNUP', status: 'ACCEPTED' },
    });
    const joinedSend = await account();
    await staff('joinedSend', {
      joinStatus: 'JOINED',
      contractStatus: 'PENDING_SEND',
      accountId: joinedSend.accountId,
      phone: joinedSend.phone,
      invitation: { invitationType: 'SIGNUP', status: 'ACCEPTED' },
    });
    // 동시 재발송 둘 — 발송 대기 → 서명 대기 전환은 하나만
    const joinedRace = await account();
    await staff('joinedSendRace', {
      joinStatus: 'JOINED',
      contractStatus: 'PENDING_SEND',
      accountId: joinedRace.accountId,
      phone: joinedRace.phone,
      invitation: { invitationType: 'SIGNUP', status: 'ACCEPTED' },
    });
    const withdrawn = await account('WITHDRAWN');
    await staff('joinedWithdrawn', {
      joinStatus: 'JOINED',
      contractStatus: 'PENDING_SIGNATURE',
      accountId: withdrawn.accountId,
      phone: withdrawn.phone,
      invitation: { invitationType: 'SIGNUP', status: 'ACCEPTED' },
    });
    const other = await account();
    // 계정은 있고 이 점포에 가입하지 않은 번호 — 소속 추가 확인(서명 대기)
    await staff('affiliation', {
      joinStatus: 'INVITED',
      contractStatus: 'PENDING_SIGNATURE',
      phone: other.phone,
      draftAction: 'AFFILIATION_CONFIRM',
      invitation: { invitationType: 'AFFILIATION_CONFIRM', status: 'SENT' },
    });
    // 소속 확인 초대였지만 그 번호의 계정이 탈퇴했다 — 재발송 api 는 가입 초대로 판별한다
    const gone = await account('WITHDRAWN');
    await staff('affiliationGone', {
      joinStatus: 'INVITED',
      contractStatus: 'PENDING_SIGNATURE',
      phone: gone.phone,
      draftAction: 'AFFILIATION_CONFIRM',
      invitation: { invitationType: 'AFFILIATION_CONFIRM', status: 'SENT' },
    });
    // 계정 없는 번호의 가입 초대 — 발송 대기 · 체결 완료
    await staff('invited', {
      joinStatus: 'INVITED',
      contractStatus: 'PENDING_SEND',
      invitation: { invitationType: 'SIGNUP', status: 'SENT' },
    });
    await staff('invitedSigned', {
      joinStatus: 'INVITED',
      contractStatus: 'SIGNED',
      invitation: { invitationType: 'SIGNUP', status: 'SENT' },
    });
    // 계정 없는 번호인데 유선번호 — 알림톡을 받지 않는다(409 SEND_PHONE_NOT_MOBILE)
    await staff('landline', {
      joinStatus: 'INVITED',
      contractStatus: 'PENDING_SEND',
      phone: `02${randomInt(10_000_000, 99_999_999)}`,
      invitation: { invitationType: 'SIGNUP', status: 'SENT' },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    alimtalkSend?.mockRestore();
    const byStaff = { staffMemberId: { in: staffIds } };
    const notifications = await prisma.notification.findMany({
      where: {
        notificationRecipients: { some: { accountId: { in: accountIds } } },
      },
      select: { notificationId: true },
    });
    const notificationIds = notifications.map((x) => x.notificationId);
    await prisma.notificationDelivery.deleteMany({
      where: {
        notificationRecipient: { notificationId: { in: notificationIds } },
      },
    });
    await prisma.notificationRecipient.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.notification.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.invitation.deleteMany({ where: byStaff });
    await prisma.contractStatusHistory.deleteMany({
      where: { contract: byStaff },
    });
    await prisma.contract.deleteMany({ where: byStaff });
    await prisma.staffMember.deleteMany({ where: byStaff });
    await prisma.account.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    if (adminId !== undefined) {
      await prisma.adminSession.deleteMany({
        where: { adminAccountId: adminId },
      });
      await prisma.adminAccount.deleteMany({
        where: { adminAccountId: adminId },
      });
    }
    await prisma.store.deleteMany({ where: { storeId } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  const token = async () =>
    (
      await app
        .get(AdminSessionService)
        .issue({ adminAccountId: adminId }, (sid) =>
          app.get(JwtService).signAsync({
            sub: adminId,
            type: 'admin',
            loginId: `resend${n}`,
            typ: 'access',
            sid,
          }),
        )
    ).accessToken;
  // 기다린 응답을 받는다(async 함수가 supertest 요청을 돌려주면 풀려 버려 .expect 를 이어 쓸 수 없다)
  const send = async (key: string, status: number) => {
    const res = await request(app.getHttpServer())
      .post(`/contracts/${ids[key].contractId}/send`)
      .set('Authorization', `Bearer ${await token()}`);
    expect({
      key,
      status: res.status,
      body: res.body as unknown,
    }).toMatchObject({ key, status });
    return res;
  };
  const contractOf = (key: string) =>
    prisma.contract.findUniqueOrThrow({
      where: { contractId: ids[key].contractId },
      select: {
        status: true,
        sentAt: true,
        signDeadlineAt: true,
        draftAction: true,
      },
    });
  const noticesOf = (key: string) =>
    prisma.notification.findMany({
      where: {
        templateCode: 'PUSH_CONTRACT_SENT',
        relatedType: 'CONTRACT',
        relatedId: ids[key].contractId,
      },
      select: {
        body: true,
        notificationRecipients: { select: { accountId: true } },
      },
    });

  // 알림톡 호출 확인이 테스트마다 따로 보이게(실패한 곳이 정확히 드러나게) — 기본 구현(거절)은 그대로 둔다
  beforeEach(() => alimtalkSend.mockClear());
  /** 날인 기한의 한국 날짜 — 알림 본문의 「M월 D일」(contract-delivery noticeSent 와 같은 계산) */
  const kstDay = (d: Date) => {
    const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일`;
  };

  it('목록 canResend 는 재발송 api 가 보낼 수 있는 줄만 참이다', async () => {
    const res = await request(app.getHttpServer())
      .get(`/staff-members?storeIds=${storeId}&pageSize=100`)
      .set('Authorization', `Bearer ${await token()}`)
      .expect(200);
    const body = res.body as StaffMemberListResponseDto;
    const canResend = Object.fromEntries(
      Object.entries(ids).map(([key, { staffMemberId }]) => [
        key,
        body.items.find((i) => i.staffMemberId === staffMemberId)?.invitation
          ?.canResend,
      ]),
    );
    expect(canResend).toEqual({
      // 가입한 직원은 가입 초대 재발송 대상이 아니다 — 앱 알림 재발송은 근로계약 상세에서
      joinedSigning: false,
      joinedSend: false,
      joinedSendRace: false,
      joinedWithdrawn: false,
      // 그 번호에 계정이 있으면 소속 추가 확인 요청을 다시 보낸다(WHALEERP-130)
      affiliation: true,
      // 계정이 탈퇴해 없으니 api 는 가입 초대로 보낸다
      affiliationGone: true,
      invited: true,
      invitedSigned: false,
      landline: false,
    });
  });

  it('가입한 직원의 서명 대기 계약 재발송은 200 — 날인 기한 · 발송 일시를 새로 잡고 근로계약서 발송 알림을 한 줄 만든다, 알림톡은 없다', async () => {
    const before = await contractOf('joinedSigning');
    const started = Date.now();
    const res = await send('joinedSigning', 200);
    expect(res.body).toMatchObject({
      contractId: ids.joinedSigning.contractId,
      status: 'PENDING_SIGNATURE',
    });
    const after = await contractOf('joinedSigning');
    expect(after.status).toBe('PENDING_SIGNATURE');
    expect(after.sentAt!.getTime()).toBeGreaterThan(before.sentAt!.getTime());
    expect(after.sentAt!.getTime()).toBeGreaterThanOrEqual(started - 1000);
    expect(after.signDeadlineAt!.getTime() - after.sentAt!.getTime()).toBe(
      SEND_VALID_MS,
    );
    expect(new Date((res.body as { sentAt: string }).sentAt).getTime()).toBe(
      after.sentAt!.getTime(),
    );
    const notices = await noticesOf('joinedSigning');
    expect(notices).toHaveLength(1);
    expect(notices[0].notificationRecipients).toEqual([
      {
        accountId: (
          await prisma.staffMember.findUniqueOrThrow({
            where: { staffMemberId: ids.joinedSigning.staffMemberId },
          })
        ).accountId,
      },
    ]);
    expect(notices[0].body).toContain('모리커피 연남점');
    // 본문의 날인 기한은 새 기한(한국 날짜)이다 — 앞 기한이 아니다
    expect(notices[0].body).toContain(kstDay(after.signDeadlineAt!));
    expect(kstDay(after.signDeadlineAt!)).not.toBe(
      kstDay(before.signDeadlineAt!),
    );
    expect(alimtalkSend).not.toHaveBeenCalled();

    // 한 번 더 보내면 알림도 한 줄 더 — 보낼 때마다 하나다
    await send('joinedSigning', 200);
    expect(await noticesOf('joinedSigning')).toHaveLength(2);
  });

  it('가입한 직원의 발송 대기 계약은 서명 대기로 넘겨 보낸다 — 상태 이력(ADMIN) 한 줄', async () => {
    const res = await send('joinedSend', 200);
    expect(res.body).toMatchObject({ status: 'PENDING_SIGNATURE' });
    expect((await contractOf('joinedSend')).status).toBe('PENDING_SIGNATURE');
    const history = await prisma.contractStatusHistory.findMany({
      where: { contractId: ids.joinedSend.contractId },
      select: { fromStatus: true, toStatus: true, actor: true },
    });
    expect(history).toEqual([
      {
        fromStatus: 'PENDING_SEND',
        toStatus: 'PENDING_SIGNATURE',
        actor: 'ADMIN',
      },
    ]);
    expect(await noticesOf('joinedSend')).toHaveLength(1);
    expect(alimtalkSend).not.toHaveBeenCalled();
  });

  it('가입한 직원의 발송 대기 계약에 재발송 둘이 동시에 오면 둘 다 200 — 전환 이력은 한 줄, 알림은 두 줄', async () => {
    const [a, b] = await Promise.all([
      send('joinedSendRace', 200),
      send('joinedSendRace', 200),
    ]);
    expect([a.body, b.body]).toEqual([
      expect.objectContaining({ status: 'PENDING_SIGNATURE' }),
      expect.objectContaining({ status: 'PENDING_SIGNATURE' }),
    ]);
    expect((await contractOf('joinedSendRace')).status).toBe(
      'PENDING_SIGNATURE',
    );
    const history = await prisma.contractStatusHistory.findMany({
      where: { contractId: ids.joinedSendRace.contractId },
      select: { fromStatus: true, toStatus: true },
    });
    expect(history).toEqual([
      { fromStatus: 'PENDING_SEND', toStatus: 'PENDING_SIGNATURE' },
    ]);
    expect(await noticesOf('joinedSendRace')).toHaveLength(2);
    expect(alimtalkSend).not.toHaveBeenCalled();
  });

  it('가입한 직원의 계정이 탈퇴했으면 기한만 새로 잡고 알림은 만들지 않는다(첫 발송과 같다, NTF-25)', async () => {
    const before = await contractOf('joinedWithdrawn');
    await send('joinedWithdrawn', 200);
    const after = await contractOf('joinedWithdrawn');
    expect(after.sentAt!.getTime()).toBeGreaterThan(before.sentAt!.getTime());
    expect(await noticesOf('joinedWithdrawn')).toHaveLength(0);
  });

  it('소속 추가 확인(계정 있음 · 이 점포 미가입)은 소속 추가 확인 요청을 새로 보낸다 — 옛 서명 대기는 수락 전이라 발송 대기로, 날인 기한은 없앤다(WHALEERP-130)', async () => {
    const res = await send('affiliation', 200);
    expect(res.body).toMatchObject({
      status: 'PENDING_SEND',
      signDeadlineAt: null,
    });
    const after = await contractOf('affiliation');
    expect(after).toMatchObject({
      status: 'PENDING_SEND',
      signDeadlineAt: null,
      draftAction: 'AFFILIATION_CONFIRM',
    });
    expect(alimtalkSend).toHaveBeenCalledTimes(1);
    const [input] = alimtalkSend.mock.calls[0] as [{ templateCode: string }];
    expect(input).toMatchObject({
      templateCode: 'TALK_STAFF_AFFILIATION_REQUEST',
    });
  });

  it('체결 완료 계약은 409 CONTRACT_STATUS_CONFLICT, 유선번호는 409 SEND_PHONE_NOT_MOBILE — 목록이 거짓으로 낸 줄', async () => {
    expect((await send('invitedSigned', 409)).body).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
    });
    expect((await send('landline', 409)).body).toMatchObject({
      code: 'SEND_PHONE_NOT_MOBILE',
    });
    expect(alimtalkSend).not.toHaveBeenCalled();
  });

  // 목록이 참으로 낸 줄은 실제로 보낼 수 있어야 한다 — 이 테스트에서만 알림톡 접수 성공을 준다
  it.each([['invited'], ['affiliationGone']])(
    '목록 canResend 가 참인 줄(%s)은 재발송 200 — 상태 그대로 · 새 SENT 초대 한 줄 · 알림톡 1번',
    async (key) => {
      alimtalkSend.mockResolvedValueOnce({ referenceKey: 'e2e' });
      const before = await contractOf(key);
      const res = await send(key, 200);
      expect(res.body).toMatchObject({
        contractId: ids[key].contractId,
        status: before.status,
      });
      const after = await contractOf(key);
      expect(after.status).toBe(before.status);
      expect(after.sentAt!.getTime()).toBeGreaterThan(before.sentAt!.getTime());
      // 소속 확인으로 보낸 계약도 그 계정이 탈퇴했으면 가입 초대로 판별해 적는다
      expect(after.draftAction).toBe('SIGNUP_INVITE');
      const sent = await prisma.invitation.findMany({
        where: { staffMemberId: ids[key].staffMemberId, status: 'SENT' },
        select: { invitationType: true, channel: true },
      });
      // 앞서 나간 초대는 무효(EXPIRED)가 되고 새 가입 초대 하나만 살아 있다
      expect(sent).toEqual([
        { invitationType: 'REINVITE', channel: 'ALIMTALK' },
      ]);
      expect(alimtalkSend).toHaveBeenCalledTimes(1);
      const [input] = alimtalkSend.mock.calls[0] as [{ templateCode: string }];
      expect(input).toMatchObject({
        templateCode: 'TALK_STAFF_INVITATION',
      });
      expect(await noticesOf(key)).toHaveLength(0);
    },
  );
});
