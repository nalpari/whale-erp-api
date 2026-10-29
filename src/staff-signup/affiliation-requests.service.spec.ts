import { HttpException } from '@nestjs/common';
import { SEND_VALID_MS } from '../contracts/contract-delivery.service';
import type { OpsNotificationService } from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { noticeStaff } from '../notifications/staff-notice';
import { PrismaService } from '../prisma/prisma.service';
import { AffiliationRequestsService } from './affiliation-requests.service';
import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';

jest.mock('../contracts/contracts.service', () => ({
  lockPeople: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../notifications/staff-notice', () => ({
  noticeStaff: jest.fn().mockResolvedValue(true),
}));
jest.mock('../notifications/recipients', () => ({
  storeManagers: jest.fn().mockResolvedValue([71]),
}));

const PHONE = '01012345678';
const NOW = new Date('2026-10-27T01:00:00.000Z');
const LATER = new Date('2026-11-26T01:00:00.000Z');

// 소속 추가 확인 요청에 직원이 답한다(WHALEERP-130 · 144)
describe('AffiliationRequestsService', () => {
  let tx: {
    $executeRaw: jest.Mock;
    account: { findUnique: jest.Mock; update: jest.Mock };
    invitation: { findUnique: jest.Mock; updateMany: jest.Mock };
    staffMember: { findFirst: jest.Mock; updateMany: jest.Mock };
    store: { findUnique: jest.Mock };
    contract: {
      updateManyAndReturn: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
    };
    contractStatusHistory: { createManyAndReturn: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };
  let ops: { notify: jest.Mock };

  /** 잠근 뒤 다시 읽는 요청 — 기본은 내 것 · 보냄 · 기한 안 · 번호 같음 */
  const request = (
    over: Record<string, unknown> = {},
    staff: Record<string, unknown> = {},
  ) =>
    tx.invitation.findUnique
      .mockResolvedValueOnce({
        staffMemberId: 19,
        invitationType: 'AFFILIATION_CONFIRM',
      })
      .mockResolvedValueOnce({
        status: 'SENT',
        expiresAt: LATER,
        staffMember: {
          staffMemberId: 19,
          storeId: 4,
          name: '남도현',
          phone: PHONE,
          accountId: null,
          candidateAccountId: 5,
          ...staff,
        },
        ...over,
      });
  const service = () =>
    new AffiliationRequestsService(
      prisma as unknown as PrismaService,
      ops as unknown as OpsNotificationService,
    );
  const codeOf = async (promise: Promise<unknown>) => {
    const e = (await promise.catch((x: unknown) => x)) as HttpException;
    expect(e).toBeInstanceOf(HttpException);
    const body = e.getResponse() as { code?: string };
    return { status: e.getStatus(), code: body.code };
  };

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      account: {
        findUnique: jest.fn().mockResolvedValue({
          phone: PHONE,
          // 근로계약서 이름(남도현)과 공백만 다르게 둬 같은 이름으로 보는지도 함께 본다(sameName)
          realName: '남 도현',
          status: 'JOINED',
          isHqSharingConsented: false,
        }),
        update: jest.fn(),
      },
      invitation: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      store: {
        findUnique: jest.fn().mockResolvedValue({
          name: '모리커피 연남점',
          storeTypeCode: 'DIRECT',
        }),
      },
      contract: {
        updateManyAndReturn: jest.fn().mockResolvedValue([{ contractId: 7 }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ createdBy: 9 }]),
      },
      contractStatusHistory: {
        createManyAndReturn: jest
          .fn()
          .mockResolvedValue([{ contractId: 7, contractStatusHistoryId: 70 }]),
      },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    (noticeStaff as jest.Mock).mockClear();
    (storeManagers as jest.Mock).mockClear();
  });

  describe('accept', () => {
    it('계정을 잇고 발송 대기 계약을 서명 대기로 — 날인 기한은 수락부터 30일, 날인 요청 직원 알림', async () => {
      request();
      await expect(service().accept(5, 41, {}, NOW)).resolves.toEqual({
        staffMemberId: 19,
        storeName: '모리커피 연남점',
        contractIds: [7],
      });
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { invitationId: 41, status: 'SENT' },
        data: { status: 'ACCEPTED', respondedAt: NOW },
      });
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: 19, accountId: null },
        data: { accountId: 5, joinStatus: 'JOINED', candidateAccountId: null },
      });
      expect(tx.contract.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { staffMemberId: 19, status: 'PENDING_SEND' },
          data: { status: 'PENDING_SIGNATURE' },
        }),
      );
      expect(tx.contract.updateMany).toHaveBeenCalledWith({
        where: { contractId: { in: [7] } },
        data: { signDeadlineAt: new Date(NOW.getTime() + SEND_VALID_MS) },
      });
      expect(noticeStaff).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.objectContaining({
          templateCode: 'PUSH_CONTRACT_SENT',
          accountId: 5,
          relatedId: 7,
        }),
      );
      // 직영 점포라 본사 제공 동의를 묻지 않았다 — 보내도 쓰지 않는다
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('가맹(직영 아님) 점포이고 아직 동의하지 않았으면 본사 제공 동의를 근무지 더하기와 같이 저장한다', async () => {
      request();
      tx.store.findUnique.mockResolvedValue({
        name: '모리커피 합정점',
        storeTypeCode: 'FRANCHISE',
      });
      await service().accept(5, 41, { hqSharingConsented: true }, NOW);
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 5 },
        data: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: NOW,
          hqSharingWithdrawnAt: null,
        },
      });
    });

    it('가맹 점포여도 동의하지 않았거나(false) 이미 동의한 계정이면 쓰지 않는다', async () => {
      tx.store.findUnique.mockResolvedValue({
        name: '모리커피 합정점',
        storeTypeCode: 'FRANCHISE',
      });
      request();
      await service().accept(5, 41, { hqSharingConsented: false }, NOW);
      tx.account.findUnique.mockResolvedValue({
        phone: PHONE,
        realName: '남도현',
        status: 'JOINED',
        isHqSharingConsented: true,
        hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
      });
      request();
      await service().accept(5, 41, { hqSharingConsented: true }, NOW);
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('더는 받아 주지 않는 문구 버전에 동의한 계정이 동의를 보내면 지금 버전으로 덮는다(ATT-30, WHALEERP-137)', async () => {
      tx.store.findUnique.mockResolvedValue({
        name: '모리커피 합정점',
        storeTypeCode: 'FRANCHISE',
      });
      tx.account.findUnique.mockResolvedValue({
        phone: PHONE,
        realName: '남도현',
        status: 'JOINED',
        isHqSharingConsented: true,
        hqSharingConsentVersion: 'v0.9',
      });
      request();
      await service().accept(5, 41, { hqSharingConsented: true }, NOW);
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 5 },
        data: expect.objectContaining({
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
        }) as unknown,
      });
    });

    it('번호 → 계정 행 → 직원 행 순서로 잠근다 — 동의를 다시 쓰는 사이 내 정보 철회가 덮이지 않게(api #183 리뷰)', async () => {
      request();
      await service().accept(5, 41, {}, NOW);
      const sql = (tx.$executeRaw.mock.calls as unknown[][]).map((c) =>
        String(c[0]),
      );
      const account = sql.findIndex((q) => q.includes('FROM accounts'));
      const staff = sql.findIndex((q) => q.includes('FROM staff_members'));
      expect(account).toBeGreaterThan(-1);
      expect(account).toBeLessThan(staff);
    });

    it('그 점포에 이미 재직 중인 레코드가 이 계정에 있으면 409 — 아무것도 쓰지 않는다', async () => {
      request();
      tx.staffMember.findFirst.mockResolvedValue({ staffMemberId: 30 });
      expect((await codeOf(service().accept(5, 41, {}, NOW))).status).toBe(409);
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('잠근 뒤 바꾸려는데 다른 요청(거절 · 다른 기기 수락)이 먼저 답했으면 409 AFFILIATION_REQUEST_ANSWERED', async () => {
      request();
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      expect(await codeOf(service().accept(5, 41, {}, NOW))).toEqual({
        status: 409,
        code: 'AFFILIATION_REQUEST_ANSWERED',
      });
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['수락', { status: 'ACCEPTED' }],
      ['거절', { status: 'REJECTED' }],
    ])('이미 %s한 요청은 409 AFFILIATION_REQUEST_ANSWERED', async (_, over) => {
      request(over);
      expect(await codeOf(service().accept(5, 41, {}, NOW))).toEqual({
        status: 409,
        code: 'AFFILIATION_REQUEST_ANSWERED',
      });
    });

    it.each([
      [
        '근로자 정보 수정으로 직원 레코드의 번호가 바뀌었으면',
        {},
        { phone: '01099998888' },
      ],
      ['기한이 지났으면(배치 전)', { expiresAt: NOW }, {}],
      ['다른 저장 · 재발송이 무효로 했으면', { status: 'EXPIRED' }, {}],
    ])(
      '%s 404 AFFILIATION_REQUEST_ENDED — 아무것도 쓰지 않는다',
      async (_, over, staff) => {
        request(over, staff);
        expect(await codeOf(service().accept(5, 41, {}, NOW))).toEqual({
          status: 404,
          code: 'AFFILIATION_REQUEST_ENDED',
        });
        expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      },
    );

    it('남의 요청(후보 계정이 다름) · 소속 확인이 아닌 초대 · 없는 요청은 404 AFFILIATION_REQUEST_NOT_FOUND', async () => {
      request({}, { candidateAccountId: 6 });
      expect((await codeOf(service().accept(5, 41, {}, NOW))).code).toBe(
        'AFFILIATION_REQUEST_NOT_FOUND',
      );
      tx.invitation.findUnique.mockReset().mockResolvedValueOnce({
        staffMemberId: 19,
        invitationType: 'SIGNUP',
      });
      expect((await codeOf(service().accept(5, 41, {}, NOW))).code).toBe(
        'AFFILIATION_REQUEST_NOT_FOUND',
      );
      tx.invitation.findUnique.mockReset().mockResolvedValue(null);
      expect((await codeOf(service().accept(5, 41, {}, NOW))).code).toBe(
        'AFFILIATION_REQUEST_NOT_FOUND',
      );
    });

    it('근로계약서 이름이 계정 이름과 다르면 남의 요청과 같은 404 — 상태를 먼저 드러내지 않는다(WHALEERP-140)', async () => {
      request({}, { name: '김철수' });
      expect((await codeOf(service().accept(5, 41, {}, NOW))).code).toBe(
        'AFFILIATION_REQUEST_NOT_FOUND',
      );
      request({ status: 'REJECTED' }, { name: '김철수' });
      expect((await codeOf(service().accept(5, 41, {}, NOW))).code).toBe(
        'AFFILIATION_REQUEST_NOT_FOUND',
      );
      request({}, { name: '김철수' });
      expect((await codeOf(service().reject(5, 41, {}, NOW))).code).toBe(
        'AFFILIATION_REQUEST_NOT_FOUND',
      );
      // 이미 수락해 이 계정에 이어진 요청은 그 뒤 관리자가 이름을 바꿔도 본인에게 409(이미 답함)다
      request(
        { status: 'ACCEPTED' },
        { name: '김철수', accountId: 5, candidateAccountId: null },
      );
      expect((await codeOf(service().accept(5, 41, {}, NOW))).code).toBe(
        'AFFILIATION_REQUEST_ANSWERED',
      );
      expect(tx.invitation.updateMany).not.toHaveBeenCalled();
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
    });

    it('탈퇴 계정이면 401', async () => {
      tx.account.findUnique.mockResolvedValue({
        phone: PHONE,
        realName: '남도현',
        status: 'WITHDRAWN',
        isHqSharingConsented: false,
      });
      expect((await codeOf(service().accept(5, 41, {}, NOW))).status).toBe(401);
    });
  });

  describe('reject', () => {
    it('요청 · 발송 대기 계약을 거절 · 거부로 닫고 같은 사유를 남긴다 — 계약을 쓴 관리자에게 운영 알림(커밋 뒤)', async () => {
      request();
      // 계약을 쓴 관리자(9)가 지금도 그 근무지를 맡고 있다
      (storeManagers as jest.Mock).mockResolvedValueOnce([9, 71]);
      await service().reject(5, 41, { reason: '다른 곳에서 일해요' }, NOW);
      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { invitationId: 41, status: 'SENT' },
        data: {
          status: 'REJECTED',
          respondedAt: NOW,
          rejectReason: '다른 곳에서 일해요',
        },
      });
      expect(tx.contract.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { staffMemberId: 19, status: 'PENDING_SEND' },
          data: { status: 'REJECTED' },
        }),
      );
      expect(tx.contract.updateMany).toHaveBeenCalledWith({
        where: { contractId: { in: [7] } },
        data: { rejectReason: '다른 곳에서 일해요' },
      });
      // 레코드는 두고 잇지 않는다
      expect(tx.staffMember.updateMany).not.toHaveBeenCalled();
      expect(ops.notify).toHaveBeenCalledWith({
        templateCode: 'NTF_AFFILIATION_REJECTED',
        variables: { 직원이름: '남도현', 근무지: '모리커피 연남점' },
        related: { type: 'STAFF_MEMBER', id: 19 },
        link: '/staff-members/19',
        eventKey: '41',
        recipients: [9],
      });
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        ops.notify.mock.invocationCallOrder[0],
      );
    });

    it('사유가 없으면 남기지 않고, 함께 온 계약이 없으면 근무지 관리자에게 알린다', async () => {
      request();
      tx.contract.updateManyAndReturn.mockResolvedValue([]);
      tx.contract.findMany.mockResolvedValue([]);
      await service().reject(5, 41, {}, NOW);
      expect(
        (tx.invitation.updateMany.mock.calls as unknown[][])[0][0],
      ).toMatchObject({
        data: { rejectReason: null },
      });
      expect(storeManagers).toHaveBeenCalledWith(prisma, 19);
      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: [71] }),
      );
    });

    it('계약을 쓴 관리자가 비활성이거나 그 근무지를 더 맡지 않으면(storeManagers 에 없음) 근무지 관리자에게 보낸다(api #164 리뷰)', async () => {
      request();
      await service().reject(5, 41, {}, NOW);
      expect(ops.notify).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: [71] }),
      );
    });

    it('잠근 뒤 바꾸려는데 다른 요청(수락)이 먼저 답했으면 409 AFFILIATION_REQUEST_ANSWERED — 계약 · 알림은 없다', async () => {
      request();
      tx.invitation.updateMany.mockResolvedValue({ count: 0 });
      expect(await codeOf(service().reject(5, 41, {}, NOW))).toEqual({
        status: 409,
        code: 'AFFILIATION_REQUEST_ANSWERED',
      });
      expect(tx.contract.updateManyAndReturn).not.toHaveBeenCalled();
      expect(ops.notify).not.toHaveBeenCalled();
    });

    it('운영 알림이 실패해도 거절은 그대로다(로그만)', async () => {
      request();
      ops.notify.mockRejectedValue(new Error('db'));
      await expect(service().reject(5, 41, {}, NOW)).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('근로계약서 이름이 계정 이름과 다른 요청은 목록에 없다 — 번호를 넘겨받은 다른 사람 앞일 수 있다(WHALEERP-140)', async () => {
      const row = (invitationId: number, name: string) => ({
        invitationId,
        invitationType: 'AFFILIATION_CONFIRM',
        sentAt: NOW,
        expiresAt: LATER,
        staffMember: {
          storeId: 4,
          name,
          employmentType: 'PART_TIME',
          jobTitle: '바리스타',
          contracts: [],
        },
      });
      const findStores = jest.fn().mockResolvedValue([
        {
          storeId: 4,
          name: '모리커피 합정점',
          storeTypeCode: 'DIRECT',
          bpCode: { tradeName: '모리커피' },
        },
      ]);
      Object.assign(prisma, {
        invitation: {
          findMany: jest
            .fn()
            .mockResolvedValue([row(41, '김철수'), row(42, '남도현')]),
        },
        store: { findMany: findStores },
      });
      const items = await service().list(5, NOW);
      expect(items.map((i) => i.invitationId)).toEqual([42]);
    });

    it('내 살아 있는 요청만 — 후보 계정 · 아직 잇지 않은 레코드 · 계정 번호, 가맹이고 동의 전이면 동의를 묻는다', async () => {
      Object.assign(prisma, {
        invitation: {
          findMany: jest.fn().mockResolvedValue([
            {
              invitationId: 41,
              invitationType: 'RETURN_CONFIRM',
              sentAt: NOW,
              expiresAt: LATER,
              staffMember: {
                storeId: 4,
                name: '남도현',
                employmentType: 'PART_TIME',
                jobTitle: '바리스타',
                // 복귀 확인 — 레코드는 퇴직 전 조건이고, 알리는 것은 함께 온 계약의 조건이다
                contracts: [
                  { employmentType: 'FULL_TIME', jobTitle: '매니저' },
                ],
              },
            },
            {
              invitationId: 42,
              invitationType: 'AFFILIATION_CONFIRM',
              sentAt: NOW,
              expiresAt: LATER,
              // 계약 조건이 비었으면 레코드 값
              staffMember: {
                storeId: 4,
                name: '남도현',
                employmentType: 'PART_TIME',
                jobTitle: '바리스타',
                contracts: [{ employmentType: null, jobTitle: null }],
              },
            },
          ]),
        },
        store: {
          findMany: jest.fn().mockResolvedValue([
            {
              storeId: 4,
              name: '모리커피 합정점',
              storeTypeCode: 'FRANCHISE',
              bpCode: { tradeName: '모리커피' },
            },
          ]),
        },
      });
      await expect(service().list(5, NOW)).resolves.toEqual([
        {
          invitationId: 41,
          invitationType: 'RETURN_CONFIRM',
          storeName: '모리커피 합정점',
          bpName: '모리커피',
          employmentType: 'FULL_TIME',
          employmentTypeLabel: '정직원',
          jobTitle: '매니저',
          sentAt: NOW.toISOString(),
          expiresAt: LATER.toISOString(),
          asksHqSharingConsent: true,
        },
        {
          invitationId: 42,
          invitationType: 'AFFILIATION_CONFIRM',
          storeName: '모리커피 합정점',
          bpName: '모리커피',
          employmentType: 'PART_TIME',
          employmentTypeLabel: '파트타이머',
          jobTitle: '바리스타',
          sentAt: NOW.toISOString(),
          expiresAt: LATER.toISOString(),
          asksHqSharingConsent: true,
        },
      ]);
      expect(
        (
          (prisma.invitation as unknown as { findMany: jest.Mock }).findMany
            .mock.calls as unknown[][]
        )[0][0],
      ).toMatchObject({
        where: {
          status: 'SENT',
          expiresAt: { gt: NOW },
          invitationType: { in: ['AFFILIATION_CONFIRM', 'RETURN_CONFIRM'] },
          staffMember: {
            candidateAccountId: 5,
            accountId: null,
            phone: PHONE,
          },
        },
      });
    });
  });
});
