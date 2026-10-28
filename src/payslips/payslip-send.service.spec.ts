import {
  BadGatewayException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { PayslipListService } from './payslip-list.service';
import { PayslipSendService } from './payslip-send.service';
import { HQ_SHARING_CONSENTED } from '../admin-scope/hq-sharing';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const UPDATED = '2026-10-19T01:00:00.000Z';

const row = (over: object = {}) => ({
  payslipId: 40,
  status: 'CONFIRMED',
  updatedAt: new Date(UPDATED),
  storeId: 5,
  periodStartDate: d('2026-07-01'),
  staffMember: {
    name: '유하람',
    account: {
      email: 'haram@example.com',
      status: 'JOINED',
      isHqSharingConsented: false,
    },
  },
  payslipDispatches: [],
  ...over,
});

describe('PayslipSendService', () => {
  let service: PayslipSendService;
  let scope: { getManageableStores: jest.Mock };
  let detail: { findOne: jest.Mock };
  let mail: { send: jest.Mock } | null;
  let appUrl: string | undefined;
  let prisma: {
    $transaction: jest.Mock;
    payslip: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
    };
    payslipDispatch: { create: jest.Mock };
    payslipLog: { create: jest.Mock };
    store: { findMany: jest.Mock };
  };

  const build = async () => {
    const module = await Test.createTestingModule({
      providers: [
        PayslipSendService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: PayslipListService, useValue: detail },
        { provide: OPTIONAL_MAIL_SERVICE, useValue: mail },
        { provide: ConfigService, useValue: { get: () => appUrl } },
      ],
    }).compile();
    service = module.get(PayslipSendService);
  };

  beforeEach(async () => {
    scope = {
      getManageableStores: jest.fn().mockResolvedValue({
        roleTypeCode: 'BM',
        stores: [
          { storeId: 5, storeTypeCode: 'DIRECT' },
          { storeId: 6, storeTypeCode: 'FRANCHISE' },
        ],
      }),
    };
    detail = { findOne: jest.fn().mockResolvedValue({ payslipId: 40 }) };
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
    appUrl = 'https://staff.example.com/ignored-path';
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      payslip: {
        findFirst: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([row()]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payslipDispatch: { create: jest.fn().mockResolvedValue({}) },
      payslipLog: { create: jest.fn().mockResolvedValue({}) },
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 5, name: '모리커피 연남점' },
          { storeId: 6, name: '모리커피 청담점' },
        ]),
      },
    };
    await build();
  });

  type Args = { where: Record<string, unknown>; data: Record<string, unknown> };
  const call = (mock: jest.Mock, i = 0) =>
    (mock.mock.calls as unknown[][])[i][0] as Args;
  const send = () => service.send(9, 40, { updatedAt: UPDATED });

  describe('send (발송)', () => {
    it('관리 범위 밖 · 가려지는 명세서는 404', async () => {
      prisma.payslip.findFirst.mockResolvedValue(null);
      await expect(send()).rejects.toBeInstanceOf(NotFoundException);
      prisma.payslip.findFirst.mockResolvedValue(row({ storeId: 6 }));
      await expect(send()).rejects.toBeInstanceOf(NotFoundException);
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('확정이 아니면 409 PAYSLIP_STATUS_CONFLICT, 읽은 뒤 바뀌었으면 409 PAYSLIP_STALE — 보내지 않는다', async () => {
      prisma.payslip.findFirst.mockResolvedValue(row({ status: 'SENT' }));
      await expect(send()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STATUS_CONFLICT' },
      });
      prisma.payslip.findFirst.mockResolvedValue(
        row({ updatedAt: new Date('2026-10-19T02:00:00.000Z') }),
      );
      await expect(send()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STALE' },
      });
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('메일 설정 · 직원 앱 주소가 없으면 503, 쓰지 않는다', async () => {
      mail = null;
      await build();
      await expect(send()).rejects.toBeInstanceOf(ServiceUnavailableException);
      mail = { send: jest.fn() };
      appUrl = undefined;
      await build();
      await expect(send()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.payslip.updateMany).not.toHaveBeenCalled();
    });

    it('직원 앱 계정이 없거나 탈퇴했으면 422 NO_EMAIL', async () => {
      for (const account of [null, { email: 'a@b.c', status: 'WITHDRAWN' }]) {
        prisma.payslip.findFirst.mockResolvedValue(
          row({ staffMember: { ...row().staffMember, account } }),
        );
        await expect(send()).rejects.toMatchObject({
          response: { code: 'NO_EMAIL' },
        });
      }
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('읽은 상태 · updatedAt 으로 먼저 잡고 메일을 보낸 뒤, 발송 완료 · 발송 이력(성공) · 처리 이력(발송)', async () => {
      await expect(send()).resolves.toEqual({ payslipId: 40 });
      const claim = call(prisma.payslip.updateMany, 0);
      const claimedAt = claim.data.updatedAt as Date;
      expect(claimedAt).toBeInstanceOf(Date);
      // 발송 중 표시가 비었거나 5분 넘게 묵은 것만 잡고, 잡으면서 채운다 — 잡은 뒤에 새로 읽은 요청이 다시 잡지 못하게
      expect(claim.where).toEqual({
        payslipId: 40,
        status: 'CONFIRMED',
        updatedAt: {
          gte: new Date(UPDATED),
          lt: new Date(new Date(UPDATED).getTime() + 1),
        },
        OR: [
          { sendingStartedAt: null },
          {
            sendingStartedAt: {
              lt: new Date(claimedAt.getTime() - 5 * 60_000),
            },
          },
        ],
      });
      expect(claim.data.sendingStartedAt).toBe(claimedAt);
      expect(mail!.send).toHaveBeenCalledWith({
        templateCode: 'EMAIL_PAYSLIP_SENT',
        to: 'haram@example.com',
        variables: {
          직원이름: '유하람',
          근무지: '모리커피 연남점',
          급여월: '7월',
          링크: 'https://staff.example.com/pay/40',
        },
        sentBy: 9,
      });
      // 잡을 때 쓴 updatedAt 그대로일 때만 옮긴다 — 그사이 다시 확정된 명세서를 발송 완료로 만들지 않게
      expect(call(prisma.payslip.updateMany, 1)).toEqual({
        where: {
          payslipId: 40,
          status: { in: ['CONFIRMED', 'SENT'] },
          updatedAt: call(prisma.payslip.updateMany, 0).data.updatedAt,
        },
        data: { status: 'SENT', sendingStartedAt: null },
      });
      expect(call(prisma.payslipDispatch.create)).toEqual({
        data: {
          payslipId: 40,
          channel: 'EMAIL',
          status: 'SUCCEEDED',
          sentBy: 9,
        },
      });
      expect(call(prisma.payslipLog.create)).toEqual({
        data: {
          payslipId: 40,
          logType: 'SEND',
          fromStatus: 'CONFIRMED',
          toStatus: 'SENT',
          summary: '발송 · 이메일',
          changedBy: 9,
        },
      });
    });

    it('전에 보낸 적이 있으면(확정 취소 뒤 다시 확정) 재발송 템플릿 · 「재발송」', async () => {
      prisma.payslip.findFirst.mockResolvedValue(
        row({ payslipDispatches: [{ payslipDispatchId: 1 }] }),
      );
      await send();
      expect(mail!.send).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: 'EMAIL_PAYSLIP_RESENT' }),
      );
      expect(call(prisma.payslipLog.create).data.summary).toBe(
        '재발송 · 이메일',
      );
    });

    it('그사이 다른 요청이 잡았으면 보내지 않고 409', async () => {
      prisma.payslip.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(send()).rejects.toBeInstanceOf(ConflictException);
      expect(mail!.send).not.toHaveBeenCalled();
    });

    it('메일이 실패하면 발송 이력(실패)만 남기고 확정 그대로 — 502 SEND_FAILED', async () => {
      mail!.send.mockRejectedValue(new Error('smtp'));
      await expect(send()).rejects.toBeInstanceOf(BadGatewayException);
      expect(call(prisma.payslipDispatch.create)).toEqual({
        data: { payslipId: 40, channel: 'EMAIL', status: 'FAILED', sentBy: 9 },
      });
      expect(prisma.payslip.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.payslipLog.create).not.toHaveBeenCalled();
    });

    it('메일이 실패하면 잡을 때 바꾼 updatedAt 을 되돌린다 — 같은 화면에서 다시 보내도 409 가 아니다', async () => {
      mail!.send.mockRejectedValue(new Error('smtp'));
      await expect(send()).rejects.toBeInstanceOf(BadGatewayException);
      const claimedAt = call(prisma.payslip.updateMany, 0).data.updatedAt;
      expect(call(prisma.payslip.updateMany, 1)).toEqual({
        where: { payslipId: 40, updatedAt: claimedAt },
        data: { updatedAt: new Date(UPDATED), sendingStartedAt: null },
      });
    });

    it('메일이 나간 뒤 기록이 실패해도 「보내지 않음」으로 돌리지 않는다 — 다시 누르면 두 번 간다', async () => {
      prisma.$transaction.mockRejectedValueOnce(new Error('db'));
      await expect(send()).resolves.toBeDefined();
      expect(mail!.send).toHaveBeenCalledTimes(1);
      expect(prisma.payslipDispatch.create).not.toHaveBeenCalled();
    });

    it('메일이 실패했는데 그사이 명세서가 바뀌었으면 updatedAt 은 두고 발송 중 표시만 비운다', async () => {
      mail!.send.mockRejectedValue(new Error('smtp'));
      prisma.payslip.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      await expect(send()).rejects.toBeInstanceOf(BadGatewayException);
      const claimedAt = call(prisma.payslip.updateMany, 0).data.updatedAt;
      expect(call(prisma.payslip.updateMany, 2)).toEqual({
        where: { payslipId: 40, sendingStartedAt: claimedAt },
        data: { sendingStartedAt: null },
      });
    });

    it('보낸 뒤 그사이 확정이 취소됐거나 취소 뒤 다시 확정됐으면(updatedAt 이 바뀜) 상태는 두고 이력만 남긴다', async () => {
      prisma.payslip.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await send();
      expect(call(prisma.payslipLog.create).data).toMatchObject({
        fromStatus: null,
        toStatus: null,
      });
      // 메일은 갔는데 앱에는 발송 완료가 아닌 경우를 로그로 찾을 수 있게
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('status not moved'),
      );
      warn.mockRestore();
      // 상태는 두어도 발송 중 표시는 비운다 — 남으면 5분 동안 아무도 보내지 못한다
      expect(call(prisma.payslip.updateMany, 2)).toEqual({
        where: {
          payslipId: 40,
          sendingStartedAt: call(prisma.payslip.updateMany, 0).data.updatedAt,
        },
        data: { sendingStartedAt: null },
      });
    });
  });

  describe('resend (재발송)', () => {
    const resend = () => service.resend(9, 40, { updatedAt: UPDATED });

    it('발송 완료만 — 재발송 템플릿, 상태는 그대로라 처리 이력의 상태 칸은 비운다', async () => {
      prisma.payslip.findFirst.mockResolvedValue(row({ status: 'SENT' }));
      await expect(resend()).resolves.toEqual({ payslipId: 40 });
      expect(call(prisma.payslip.updateMany, 0).where).toMatchObject({
        status: 'SENT',
      });
      expect(mail!.send).toHaveBeenCalledWith(
        expect.objectContaining({ templateCode: 'EMAIL_PAYSLIP_RESENT' }),
      );
      expect(call(prisma.payslipLog.create).data).toMatchObject({
        logType: 'SEND',
        fromStatus: null,
        toStatus: null,
        summary: '재발송 · 이메일',
      });
    });

    it('확정 · 검토 중이면 409', async () => {
      await expect(resend()).rejects.toMatchObject({
        response: { code: 'PAYSLIP_STATUS_CONFLICT' },
      });
    });
  });

  describe('sendMany (확정 N건 발송)', () => {
    it('관리자 계정을 쓸 수 없으면 null', async () => {
      scope.getManageableStores.mockResolvedValue(null);
      expect(await service.sendMany(9, { month: '2026-07' })).toBeNull();
    });

    it('그 달 · 고른 점포 · 직원명의 확정 명세서를 보내고, 일부가 실패해도 보낸 것은 그대로 — 실패 대상을 알린다', async () => {
      prisma.payslip.findMany.mockResolvedValue([
        row(),
        row({
          payslipId: 41,
          staffMember: {
            name: '하준서',
            account: null,
          },
        }),
        row({
          payslipId: 42,
          staffMember: { ...row().staffMember, name: '최다온' },
        }),
        row({
          payslipId: 43,
          storeId: 6,
          staffMember: { ...row().staffMember, name: '숨김' },
        }),
      ]);
      mail!.send
        .mockResolvedValueOnce({ messageId: 'm1' })
        .mockRejectedValueOnce(new Error('smtp'));
      expect(
        await service.sendMany(9, { month: '2026-07', storeIds: [5, 6, 99] }),
      ).toEqual({
        sent: [{ payslipId: 40, staffName: '유하람' }],
        failed: [
          {
            payslipId: 41,
            staffName: '하준서',
            reason: 'NO_EMAIL',
            message: '직원 앱 계정이 없어(가입 전 · 탈퇴) 보낼 곳이 없습니다',
          },
          {
            payslipId: 42,
            staffName: '최다온',
            reason: 'MAIL_FAILED',
            message:
              '메일을 보내지 못했습니다. 발송 이력을 확인한 뒤 다시 보내 주세요',
          },
          {
            payslipId: null,
            staffName: null,
            reason: 'MASKED',
            message: '본사 제공 동의가 없는 직원이라 보낼 수 없습니다',
          },
        ],
      });
      expect(call(prisma.payslip.findMany).where).toEqual({
        AND: [
          { storeId: { in: [5, 6] } },
          { periodStartDate: { gte: d('2026-07-01'), lt: d('2026-08-01') } },
          { status: 'CONFIRMED' },
        ],
      });
    });

    it('직원명으로 거르면 가린 직원 명세서는 대상에서 뺀다(목록과 같다)', async () => {
      await service.sendMany(9, { month: '2026-07', staffName: '유_' });
      expect(call(prisma.payslip.findMany).where).toEqual({
        AND: [
          {
            OR: [
              { storeId: { in: [5] } },
              {
                storeId: { in: [6] },
                staffMember: {
                  account: HQ_SHARING_CONSENTED.account,
                },
              },
            ],
          },
          { periodStartDate: { gte: d('2026-07-01'), lt: d('2026-08-01') } },
          { status: 'CONFIRMED' },
          { staffMember: { name: { contains: '유\\_', mode: 'insensitive' } } },
        ],
      });
    });

    it('메일 설정이 없으면 쓰지 않고 모두 실패로 알린다', async () => {
      mail = null;
      await build();
      const result = await service.sendMany(9, { month: '2026-07' });
      expect(result!.failed).toEqual([
        expect.objectContaining({
          payslipId: 40,
          reason: 'MAIL_NOT_CONFIGURED',
        }),
      ]);
      expect(prisma.payslip.updateMany).not.toHaveBeenCalled();
    });
  });
});
