import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { hashPassword } from '../auth/password';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { OpsNotificationService } from '../notifications/ops-notification.service';
import { storeManagers } from '../notifications/recipients';
import { PrismaService } from '../prisma/prisma.service';
import { CURRENT_PASSWORD_MISMATCH_MESSAGE } from './my-password.service';
import {
  EMPLOYED_CONFLICT_MESSAGE,
  MyWithdrawalService,
} from './my-withdrawal.service';

jest.mock('../notifications/recipients', () => ({
  storeManagers: jest.fn(),
}));

const PASSWORD = 'OldPass123!';
const ACCOUNT_ID = 12;

const deleteMany = () => ({ deleteMany: jest.fn().mockResolvedValue({}) });

describe('MyWithdrawalService', () => {
  let hash: string;
  let tx: ReturnType<typeof makeTx>;
  let sessions: { revokeAll: jest.Mock };
  let ops: { notify: jest.Mock };
  let mail: { send: jest.Mock } | null;
  let service: MyWithdrawalService;
  let employed: { storeId: number; retiredDate: Date | null }[];
  let members: {
    staffMemberId: number;
    storeId: number;
    name: string;
    accountId: number | null;
  }[];
  let status: string;

  beforeAll(async () => {
    hash = await hashPassword(PASSWORD);
  });

  function makeTx() {
    const t = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            email: 'hong@example.com',
            passwordHash: status === 'WITHDRAWN' ? null : hash,
            realName: '홍길동',
            phone: '01012345678',
            status,
          }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      staffMember: {
        findMany: jest.fn((args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            'joinStatus' in args.where
              ? employed.map((e, i) => ({ ...e, staffMemberId: i + 1 }))
              : members,
          ),
        ),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 7, name: '모리커피 연남점' },
          { storeId: 8, name: '모리커피 홍대점' },
        ]),
      },
      contract: {
        updateManyAndReturn: jest.fn((args: { where: { status: string } }) =>
          Promise.resolve(
            args.where.status === 'PENDING_SIGNATURE'
              ? [{ contractId: 31, storeId: 7 }]
              : [],
          ),
        ),
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([]),
      },
      contractStatusHistory: { createMany: jest.fn().mockResolvedValue({}) },
      invitation: {
        updateMany: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      linkHold: deleteMany(),
      locationAccessLog: deleteMany(),
      locationConsentHistory: deleteMany(),
      locationConsent: deleteMany(),
      loginHistory: deleteMany(),
      accountChangeHistory: deleteMany(),
      accountTermsAgreementLog: deleteMany(),
      identityVerification: deleteMany(),
      notificationPreference: deleteMany(),
      emailChangePin: deleteMany(),
      passwordResetPin: deleteMany(),
      passwordResetLink: deleteMany(),
      authSession: { updateMany: jest.fn().mockResolvedValue({}) },
    };
    return t;
  }

  const build = async () => {
    employed = [];
    members = [
      { staffMemberId: 1, storeId: 7, name: '홍길동', accountId: ACCOUNT_ID },
      { staffMemberId: 2, storeId: 8, name: '홍길동', accountId: null },
    ];
    status = 'JOINED';
    tx = makeTx();
    sessions = { revokeAll: jest.fn().mockResolvedValue(1) };
    ops = { notify: jest.fn().mockResolvedValue(null) };
    mail = { send: jest.fn().mockResolvedValue({}) };
    (storeManagers as jest.Mock).mockImplementation((_db, id: number) =>
      Promise.resolve([100 + id]),
    );
    const prisma = {
      ...tx,
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MyWithdrawalService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthSessionService, useValue: sessions },
        { provide: OpsNotificationService, useValue: ops },
        { provide: OPTIONAL_MAIL_SERVICE, useFactory: () => mail },
      ],
    }).compile();
    service = moduleRef.get(MyWithdrawalService);
    return prisma;
  };

  const conflictBody = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as Record<
      string,
      unknown
    >;
  };

  describe('재직 판정', () => {
    it('재직 중이면 409 EMPLOYED_AFFILIATION 이고 근무지 · 퇴직일을 담는다 — 아무것도 쓰지 않는다', async () => {
      await build();
      employed = [{ storeId: 7, retiredDate: null }];

      const body = await conflictBody(service.withdraw(ACCOUNT_ID, PASSWORD));

      expect(body).toMatchObject({
        statusCode: 409,
        code: 'EMPLOYED_AFFILIATION',
        message: EMPLOYED_CONFLICT_MESSAGE,
        employedStores: [{ storeName: '모리커피 연남점', retiredDate: null }],
      });
      expect(tx.account.update).not.toHaveBeenCalled();
      expect(tx.contract.updateManyAndReturn).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
      expect(ops.notify).not.toHaveBeenCalled();
      expect(mail?.send).not.toHaveBeenCalled();
    });

    it('퇴직 예정(퇴직일이 있어도 재직)도 거절하고 퇴직일을 YYYY-MM-DD 로 준다', async () => {
      await build();
      employed = [
        { storeId: 7, retiredDate: new Date('2026-12-31T00:00:00.000Z') },
        { storeId: 8, retiredDate: null },
      ];

      const body = await conflictBody(service.withdraw(ACCOUNT_ID, PASSWORD));

      expect(body.employedStores).toEqual([
        { storeName: '모리커피 연남점', retiredDate: '2026-12-31' },
        { storeName: '모리커피 홍대점', retiredDate: null },
      ]);
    });

    it('재직 판정은 가입 완료 · 재직 레코드만 — 체결 계약(ACTIVE_STAFF)을 보지 않는다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(tx.staffMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            accountId: ACCOUNT_ID,
            joinStatus: 'JOINED',
            employmentStatus: 'EMPLOYED',
          },
        }),
      );
    });
  });

  describe('조건 조회', () => {
    it('재직 근무지가 없으면 canWithdraw true, 대기 계약 수를 센다', async () => {
      await build();
      await expect(service.getEligibility(ACCOUNT_ID)).resolves.toEqual({
        canWithdraw: true,
        employedStores: [],
        pendingContractCount: 2,
      });
      expect(tx.contract.count).toHaveBeenCalledWith({
        where: {
          status: {
            in: [
              'DRAFT',
              'PENDING_SEND',
              'PENDING_SIGNATURE',
              'CORRECTION_REQUESTED',
            ],
          },
          staffMember: {
            OR: [{ accountId: ACCOUNT_ID }, { candidateAccountId: ACCOUNT_ID }],
          },
        },
      });
    });

    it('재직 중이면 canWithdraw false 와 근무지를 준다', async () => {
      await build();
      employed = [
        { storeId: 8, retiredDate: new Date('2026-12-01T00:00:00.000Z') },
      ];
      await expect(service.getEligibility(ACCOUNT_ID)).resolves.toMatchObject({
        canWithdraw: false,
        employedStores: [
          { storeName: '모리커피 홍대점', retiredDate: '2026-12-01' },
        ],
      });
    });

    it('탈퇴한 계정은 401', async () => {
      await build();
      status = 'WITHDRAWN';
      await expect(service.getEligibility(ACCOUNT_ID)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('비밀번호 재확인', () => {
    it('틀리면 400 이고 트랜잭션을 열지 않는다', async () => {
      const prisma = await build();
      const error = await service
        .withdraw(ACCOUNT_ID, 'WrongPass1!')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        CURRENT_PASSWORD_MISMATCH_MESSAGE,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('확인한 사이 비밀번호가 바뀌었으면 400 이고 아무것도 쓰지 않는다', async () => {
      await build();
      const row = tx.account.findUnique.getMockImplementation()!;
      let calls = 0;
      tx.account.findUnique.mockImplementation(async (...args: []) => {
        calls += 1;
        const found = await row(...args);
        return calls === 1 ? found : { ...found, passwordHash: 'scrypt$other' };
      });
      await expect(service.withdraw(ACCOUNT_ID, PASSWORD)).rejects.toThrow(
        CURRENT_PASSWORD_MISMATCH_MESSAGE,
      );
      expect(tx.account.update).not.toHaveBeenCalled();
    });
  });

  describe('탈퇴 처리', () => {
    it('직원 → 계정 순으로 잠근다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);
      const sql = tx.$queryRaw.mock.calls.map(([strings]) =>
        (strings as string[]).join('?'),
      );
      expect(sql[0]).toMatch(/FROM staff_members .* FOR NO KEY UPDATE/);
      expect(sql[1]).toMatch(/FROM accounts .* FOR UPDATE/);
    });

    it('대기 계약 4종을 종료로 닫고 상태 이력 actor 를 직원(STAFF)으로 남긴다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(tx.contract.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { staffMemberId: { in: [1, 2] }, status: 'PENDING_SIGNATURE' },
          data: { status: 'ENDED' },
        }),
      );
      expect(tx.contractStatusHistory.createMany).toHaveBeenCalledWith({
        data: [
          {
            contractId: 31,
            fromStatus: 'PENDING_SIGNATURE',
            toStatus: 'ENDED',
            actor: 'STAFF',
          },
        ],
      });
    });

    it('발송 초대는 만료로, 후보 계정은 비우고, 열린 연결 보류는 지운다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(tx.invitation.updateMany).toHaveBeenCalledWith({
        where: { staffMemberId: { in: [1, 2] }, status: 'SENT' },
        data: { status: 'EXPIRED' },
      });
      expect(tx.staffMember.updateMany).toHaveBeenCalledWith({
        where: { candidateAccountId: ACCOUNT_ID },
        data: { candidateAccountId: null },
      });
      expect(tx.linkHold.deleteMany).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT_ID, resolution: null },
      });
    });

    it('위치정보와 계정에 달린 개인정보를 지운다 — 동의 이력이 동의보다 먼저', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      const where = { where: { accountId: ACCOUNT_ID } };
      expect(tx.locationAccessLog.deleteMany).toHaveBeenCalledWith(where);
      expect(tx.locationConsentHistory.deleteMany).toHaveBeenCalledWith({
        where: { locationConsent: { accountId: ACCOUNT_ID } },
      });
      expect(tx.locationConsent.deleteMany).toHaveBeenCalledWith(where);
      expect(
        tx.locationConsentHistory.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.locationConsent.deleteMany.mock.invocationCallOrder[0]);
      expect(tx.loginHistory.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { accountId: ACCOUNT_ID },
            { accountId: null, email: 'hong@example.com' },
          ],
        },
      });
      expect(tx.identityVerification.deleteMany).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT_ID },
      });
      for (const table of [
        tx.accountChangeHistory,
        tx.accountTermsAgreementLog,
        tx.notificationPreference,
        tx.emailChangePin,
        tx.passwordResetPin,
        tx.passwordResetLink,
      ])
        expect(table.deleteMany).toHaveBeenCalledWith(where);
    });

    it('접속을 모두 끊고 기기 식별 정보를 비운다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(sessions.revokeAll).toHaveBeenCalledWith(ACCOUNT_ID, tx);
      expect(tx.authSession.updateMany).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT_ID },
        data: { deviceIdentifier: null },
      });
    });

    it('계정 행은 지우지 않고 개인정보 칸을 비운다 — 본사 제공 동의는 동의한 적 없음으로', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT_ID },
        data: {
          status: 'WITHDRAWN',
          email: null,
          passwordHash: null,
          realName: null,
          birthDate: null,
          phone: null,
          gender: null,
          isForeigner: false,
          connectingInformation: null,
          zipCode: null,
          address: null,
          addressDetail: null,
          isHqSharingConsented: false,
          hqSharingConsentVersion: null,
          hqSharingAgreedAt: null,
          hqSharingWithdrawnAt: null,
          termsAgreedAt: null,
          failedLoginCount: 0,
          lockExpiresAt: null,
        },
      });
    });
  });

  describe('커밋 뒤', () => {
    it('이 계정에 이어진 직원 레코드의 근무지 관리자에게만 알린다 — 계약을 닫지도 초대를 만료시키지도 않는 후보 레코드는 알리지 않는다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(ops.notify).toHaveBeenCalledTimes(1);
      expect(ops.notify).toHaveBeenCalledWith({
        templateCode: 'NTF_STAFF_WITHDRAWN',
        variables: { 직원이름: '홍길동', 근무지: '모리커피 연남점' },
        related: { type: 'STAFF_MEMBER', id: 1 },
        link: '/staff-members/1',
        eventKey: `${ACCOUNT_ID}:1`,
        recipients: [101],
      });
    });

    it('후보 레코드도 대기 계약을 닫았거나 초대를 만료시켰으면 그 근무지에 알린다 — 같은 근무지는 한 번', async () => {
      await build();
      members.push(
        { staffMemberId: 3, storeId: 8, name: '홍길동', accountId: null },
        { staffMemberId: 4, storeId: 8, name: '홍길동', accountId: null },
      );
      tx.contract.findMany.mockResolvedValue([{ staffMemberId: 2 }]);
      tx.invitation.findMany.mockResolvedValue([{ staffMemberId: 3 }]);

      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(
        ops.notify.mock.calls.map(
          ([n]: [{ related: { id: number } }]) => n.related.id,
        ),
      ).toEqual([1, 2]);
    });

    it('같은 근무지에 이어진 레코드가 둘이면(재입사) 한 번만 알린다 — 이어진 레코드가 후보보다 먼저', async () => {
      await build();
      members.splice(
        0,
        members.length,
        { staffMemberId: 1, storeId: 7, name: '홍길동', accountId: null },
        { staffMemberId: 2, storeId: 7, name: '홍길동', accountId: ACCOUNT_ID },
        { staffMemberId: 3, storeId: 7, name: '홍길동', accountId: ACCOUNT_ID },
      );
      tx.contract.findMany.mockResolvedValue([{ staffMemberId: 1 }]);

      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(
        ops.notify.mock.calls.map(
          ([n]: [{ related: { id: number } }]) => n.related.id,
        ),
      ).toEqual([2]);
    });

    it('받는 사람은 동의를 지우기 전에 정한다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(
        (storeManagers as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(tx.account.update.mock.invocationCallOrder[0]);
    });

    it('완료 메일은 지우기 전에 읽어 둔 이메일로 보낸다', async () => {
      await build();
      await service.withdraw(ACCOUNT_ID, PASSWORD);

      expect(mail?.send).toHaveBeenCalledWith({
        templateCode: 'EMAIL_STAFF_WITHDRAW_DONE',
        to: 'hong@example.com',
        variables: { 직원이름: '홍길동' },
        accountId: ACCOUNT_ID,
      });
    });

    it('메일을 보내지 못해도 탈퇴는 끝난다', async () => {
      await build();
      mail?.send.mockRejectedValue(new Error('smtp down'));

      await expect(
        service.withdraw(ACCOUNT_ID, PASSWORD),
      ).resolves.toBeUndefined();
      expect(tx.account.update).toHaveBeenCalledTimes(1);
    });

    it('메일 설정이 없으면 메일만 건너뛴다', async () => {
      await build();
      mail = null;
      const moduleRef = await Test.createTestingModule({
        providers: [
          MyWithdrawalService,
          {
            provide: PrismaService,
            useValue: {
              ...tx,
              $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
            },
          },
          { provide: AuthSessionService, useValue: sessions },
          { provide: OpsNotificationService, useValue: ops },
          { provide: OPTIONAL_MAIL_SERVICE, useValue: null },
        ],
      }).compile();

      await expect(
        moduleRef.get(MyWithdrawalService).withdraw(ACCOUNT_ID, PASSWORD),
      ).resolves.toBeUndefined();
      expect(ops.notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('교착', () => {
    const deadlock = () =>
      new Prisma.PrismaClientKnownRequestError('deadlock', {
        code: 'P2034',
        clientVersion: 'x',
      });

    it('한 번은 처음부터 다시 한다', async () => {
      const prisma = await build();
      prisma.$transaction
        .mockImplementationOnce(() => Promise.reject(deadlock()))
        .mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));

      await expect(
        service.withdraw(ACCOUNT_ID, PASSWORD),
      ).resolves.toBeUndefined();
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('또 교착이면 409 로 바뀐 것 없음을 알린다', async () => {
      const prisma = await build();
      prisma.$transaction.mockImplementation(() => Promise.reject(deadlock()));

      const body = await conflictBody(service.withdraw(ACCOUNT_ID, PASSWORD));

      expect(body.message).toContain('바뀐 것은 없으니');
      expect(ops.notify).not.toHaveBeenCalled();
    });
  });
});
