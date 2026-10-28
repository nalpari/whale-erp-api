import {
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import {
  HQ_SHARING_CONSENT_VERSION,
  MyConsentService,
} from './my-consent.service';

const AGREED_AT = new Date('2026-10-01T00:00:00Z');

const activeRow = (patch: Record<string, unknown> = {}) => ({
  locationConsentId: 5,
  consentVersion: 'v1.0',
  pausedAt: null,
  ...patch,
});

describe('MyConsentService', () => {
  let tx: {
    $queryRaw: jest.Mock;
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    locationConsent: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    termsVersion: { findFirst: jest.Mock };
    locationConsentHistory: { create: jest.Mock };
  };
  /** 동의 이력 줄(ATT-26) — [동의 ID, 처리 구분, 시각] 차례로 */
  const histories = () =>
    (
      tx.locationConsentHistory.create.mock.calls as [
        {
          data: {
            locationConsentId: number;
            action: string;
            occurredAt: Date;
          };
        },
      ][]
    ).map(([{ data }]) => [
      data.locationConsentId,
      data.action,
      data.occurredAt,
    ]);

  const build = async (account: Record<string, unknown> = {}) => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: 'JOINED',
          isHqSharingConsented: false,
          ...account,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      locationConsent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ locationConsentId: 9 }),
        update: jest.fn().mockResolvedValue({}),
      },
      termsVersion: {
        findFirst: jest.fn().mockResolvedValue({ version: 'v1.0' }),
      },
      locationConsentHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MyConsentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    return moduleRef.get(MyConsentService);
  };

  describe('위치정보 동의 (ATT-23 · ATT-26)', () => {
    it('철회하지 않은 동의가 없으면 지금 시행 중인 LOCATION 약관 버전으로 새 동의를 만든다', async () => {
      const service = await build();
      await service.agreeLocation(12);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.termsVersion.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            termsTypeCode: 'LOCATION',
            isActive: true,
            isDeleted: false,
            // 시행일이 아직 오지 않은 다음 버전에 동의가 남지 않게
            effectiveDate: { lte: kstToday() },
          }) as unknown,
          orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
        }),
      );
      const { data } = (
        tx.locationConsent.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0];
      expect(data).toEqual({
        accountId: 12,
        consentVersion: 'v1.0',
        agreedAt: expect.any(Date) as unknown,
        pausedAt: null,
      });
      expect(tx.locationConsent.update).not.toHaveBeenCalled();
      // 동의 이력 — 새 동의에 동의 한 줄, 동의 시각과 같다(ATT-26)
      expect(histories()).toEqual([[9, 'AGREE', data.agreedAt]]);
    });

    it('동의한 버전이 지금 시행 중인 것과 다르면 앞 행을 닫고 새 버전 행을 만든다 — 일시 중지는 그대로 (ATT-23)', async () => {
      const service = await build();
      const pausedAt = new Date('2026-10-10T00:00:00Z');
      tx.locationConsent.findFirst.mockResolvedValue(
        activeRow({ consentVersion: 'v0.9', pausedAt }),
      );
      await service.agreeLocation(12);
      const closed = (
        tx.locationConsent.update.mock.calls[0] as [
          { where: unknown; data: { withdrawnAt: Date } },
        ]
      )[0];
      expect(closed.where).toEqual({ locationConsentId: 5 });
      const { data } = (
        tx.locationConsent.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0];
      expect(data).toEqual({
        accountId: 12,
        consentVersion: 'v1.0',
        agreedAt: closed.data.withdrawnAt,
        pausedAt,
      });
      // 부분 고유 인덱스(철회 안 한 동의는 계정에 하나) — 닫은 뒤에 만든다
      expect(
        tx.locationConsent.update.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.locationConsent.create.mock.invocationCallOrder[0]);
      // 동의 이력 — 앞 동의에 철회, 새 동의에 동의 한 줄씩(같은 시각)
      expect(histories()).toEqual([
        [5, 'WITHDRAW', closed.data.withdrawnAt],
        [9, 'AGREE', closed.data.withdrawnAt],
      ]);
    });

    it('이미 지금 버전에 동의 중이면 409 이고 새 행을 만들지 않는다 — 철회 안 한 동의는 계정에 하나', async () => {
      const service = await build();
      tx.locationConsent.findFirst.mockResolvedValue(activeRow());
      await expect(service.agreeLocation(12)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.locationConsent.create).not.toHaveBeenCalled();
      expect(tx.locationConsentHistory.create).not.toHaveBeenCalled();
    });

    it('화면이 보여 준 약관 버전이 시행 중인 것과 같으면 받는다 (WHALEERP-628)', async () => {
      const service = await build();
      await service.agreeLocation(12, 'v1.0');
      expect(tx.locationConsent.create).toHaveBeenCalledTimes(1);
    });

    it('화면이 보여 준 약관 버전이 그사이 바뀌었으면 409 이고 동의를 남기지 않는다 (WHALEERP-628)', async () => {
      const service = await build();
      tx.termsVersion.findFirst.mockResolvedValue({ version: 'v1.1' });
      await expect(service.agreeLocation(12, 'v1.0')).rejects.toThrow(
        new ConflictException(
          '그사이 위치정보 약관이 바뀌었습니다. 바뀐 약관을 확인하고 다시 동의해 주세요',
        ),
      );
      expect(tx.locationConsent.create).not.toHaveBeenCalled();
      expect(tx.locationConsent.update).not.toHaveBeenCalled();
      expect(tx.locationConsentHistory.create).not.toHaveBeenCalled();
    });

    it('화면이 보여 준 버전이 null 이면 빼고 보낸 것과 같다 — 시행 중인 버전으로 받는다', async () => {
      const service = await build();
      await service.agreeLocation(12, null);
      expect(tx.locationConsent.create).toHaveBeenCalledTimes(1);
    });

    it('시행 중인 약관이 없으면 화면이 버전을 보냈어도 500 이 먼저다 — 운영 장애를 「약관 바뀜」으로 가리지 않는다', async () => {
      const service = await build();
      tx.termsVersion.findFirst.mockResolvedValue(null);
      await expect(service.agreeLocation(12, 'v1.0')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('시행 중인 위치정보 약관이 없으면 500 과 안내 문구 — 버전 없는 동의를 남기지 않는다', async () => {
      const service = await build();
      tx.termsVersion.findFirst.mockResolvedValue(null);
      await expect(service.agreeLocation(12)).rejects.toThrow(
        new InternalServerErrorException(
          '지금은 위치정보 동의를 받을 수 없습니다. 관리자에게 문의해 주세요',
        ),
      );
      expect(tx.locationConsent.create).not.toHaveBeenCalled();
    });

    it('잠시 멈춤은 동의 중일 때만 — 일시 중지 시각을 채운다', async () => {
      const service = await build();
      tx.locationConsent.findFirst.mockResolvedValue(activeRow());
      await service.pauseLocation(12);
      expect(tx.locationConsent.update).toHaveBeenCalledWith({
        where: { locationConsentId: 5 },
        data: { pausedAt: expect.any(Date) as unknown },
      });
      expect(histories()).toEqual([[5, 'PAUSE', expect.any(Date)]]);
    });

    it('이미 멈췄으면 잠시 멈춤은 409', async () => {
      const service = await build();
      tx.locationConsent.findFirst.mockResolvedValue(
        activeRow({ pausedAt: AGREED_AT }),
      );
      await expect(service.pauseLocation(12)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('다시 켜기는 멈춘 동안만 — 새로 동의하지 않고 일시 중지 시각만 지운다', async () => {
      const service = await build();
      tx.locationConsent.findFirst.mockResolvedValue(
        activeRow({ pausedAt: AGREED_AT }),
      );
      await service.resumeLocation(12);
      expect(tx.locationConsent.update).toHaveBeenCalledWith({
        where: { locationConsentId: 5 },
        data: { pausedAt: null },
      });
      expect(tx.locationConsent.create).not.toHaveBeenCalled();
      expect(histories()).toEqual([[5, 'RESUME', expect.any(Date)]]);
    });

    it('멈추지 않았으면 다시 켜기는 409', async () => {
      const service = await build();
      tx.locationConsent.findFirst.mockResolvedValue(activeRow());
      await expect(service.resumeLocation(12)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it.each([
      ['동의 중', null],
      ['멈춘 동안', AGREED_AT],
    ])('철회는 %s 에도 된다 — 철회 시각을 채운다', async (_, pausedAt) => {
      const service = await build();
      tx.locationConsent.findFirst.mockResolvedValue(activeRow({ pausedAt }));
      await service.withdrawLocation(12);
      expect(tx.locationConsent.update).toHaveBeenCalledWith({
        where: { locationConsentId: 5 },
        data: { withdrawnAt: expect.any(Date) as unknown },
      });
      expect(histories()).toEqual([[5, 'WITHDRAW', expect.any(Date)]]);
    });

    it.each(['pauseLocation', 'resumeLocation', 'withdrawLocation'] as const)(
      '동의가 없으면 %s 는 409',
      async (method) => {
        const service = await build();
        await expect(service[method](12)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(tx.locationConsent.update).not.toHaveBeenCalled();
        expect(tx.locationConsentHistory.create).not.toHaveBeenCalled();
      },
    );

    it('철회하지 않은 행 하나만 찾는다 — 그 계정의 것으로', async () => {
      const service = await build();
      tx.locationConsent.findFirst.mockResolvedValue(activeRow());
      await service.withdrawLocation(12);
      expect(tx.locationConsent.findFirst).toHaveBeenCalledWith({
        where: { accountId: 12, withdrawnAt: null },
        select: {
          locationConsentId: true,
          consentVersion: true,
          pausedAt: true,
        },
      });
    });
  });

  describe('본사 제공 동의 (ATT-30, 계정에 하나)', () => {
    it('다시 동의하면 api 의 문구 버전 · 지금 시각으로 덮고 철회 시각을 지운다 (A안)', async () => {
      const service = await build();
      await service.agreeHqSharing(12);
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 12 },
        data: {
          isHqSharingConsented: true,
          hqSharingConsentVersion: HQ_SHARING_CONSENT_VERSION,
          hqSharingAgreedAt: expect.any(Date) as unknown,
          hqSharingWithdrawnAt: null,
        },
      });
    });

    it('이미 동의 중이면 다시 동의는 409', async () => {
      const service = await build({ isHqSharingConsented: true });
      await expect(service.agreeHqSharing(12)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('철회는 false 와 철회 시각만 — 동의한 버전과 시각은 남긴다(CHECK 가 요구한다)', async () => {
      const service = await build({ isHqSharingConsented: true });
      await service.withdrawHqSharing(12);
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 12 },
        data: {
          isHqSharingConsented: false,
          hqSharingWithdrawnAt: expect.any(Date) as unknown,
        },
      });
    });

    it('동의 중이 아니면 철회는 409', async () => {
      const service = await build();
      await expect(service.withdrawHqSharing(12)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  it.each([
    'agreeLocation',
    'pauseLocation',
    'resumeLocation',
    'withdrawLocation',
    'agreeHqSharing',
    'withdrawHqSharing',
  ] as const)('탈퇴 계정은 %s 가 401', async (method) => {
    const service = await build({ status: 'WITHDRAWN' });
    await expect(service[method](12)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
