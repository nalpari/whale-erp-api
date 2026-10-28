import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MyProfileService } from './my-profile.service';

/** 첫 호출의 첫 인자 — Prisma 호출 하나를 본다 */
type Call = { where: unknown; select: Record<string, unknown> };
const firstArg = (mock: jest.Mock) => (mock.mock.calls[0] as [Call])[0];
const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const AGREED_AT = new Date('2026-10-01T01:00:00Z');

const accountRow = (patch: Record<string, unknown> = {}) => ({
  accountId: 12,
  email: 'hong@example.com',
  realName: '홍길동',
  birthDate: d('1998-03-04'),
  phone: '01012345678',
  zipCode: '06236',
  address: '서울 강남구 테헤란로 1',
  addressDetail: '3층',
  status: 'JOINED',
  isHqSharingConsented: true,
  hqSharingConsentVersion: 'v1.0',
  hqSharingAgreedAt: AGREED_AT,
  hqSharingWithdrawnAt: null,
  locationConsents: [],
  createdAt: new Date('2026-09-01T00:00:00Z'),
  accountChangeHistories: [],
  ...patch,
});

describe('MyProfileService', () => {
  let findUnique: jest.Mock;
  let termsFindFirst: jest.Mock;

  const build = async () => {
    findUnique = jest.fn().mockResolvedValue(accountRow());
    termsFindFirst = jest.fn().mockResolvedValue({ version: 'v1.0' });
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MyProfileService,
        {
          provide: PrismaService,
          useValue: {
            account: { findUnique },
            termsVersion: { findFirst: termsFindFirst },
          },
        },
      ],
    }).compile();
    return moduleRef.get(MyProfileService);
  };

  it('토큰의 계정 하나만 읽고, 소속 · 신고 정보는 읽지 않는다(따로 부른다)', async () => {
    const service = await build();
    await service.get(12);
    const arg = firstArg(findUnique);
    expect(arg.where).toEqual({ accountId: 12 });
    expect(arg.select).not.toHaveProperty('staffMembers');
  });

  it('계정 칸 · 본사 제공 동의(계정에 하나) · 위치정보 동의를 한 응답으로', async () => {
    const service = await build();
    expect(await service.get(12)).toEqual({
      accountId: 12,
      email: 'hong@example.com',
      realName: '홍길동',
      birthDate: '1998-03-04',
      phone: '01012345678',
      zipCode: '06236',
      address: '서울 강남구 테헤란로 1',
      addressDetail: '3층',
      status: 'JOINED',
      hqSharingConsent: {
        isConsented: true,
        consentVersion: 'v1.0',
        agreedAt: AGREED_AT,
        withdrawnAt: null,
        needsReconsent: false,
      },
      locationConsent: {
        state: 'NOT_AGREED',
        consentVersion: null,
        agreedAt: null,
        pausedAt: null,
        withdrawnAt: null,
        needsReconsent: false,
      },
      passwordChangedAt: new Date('2026-09-01T00:00:00Z'),
    });
  });

  it('비밀번호를 바꾼 적이 있으면 마지막 변경 시각, 없으면 가입 시각 (WHALEERP-194 권유 문구)', async () => {
    const service = await build();
    const changedAt = new Date('2026-10-05T00:00:00Z');
    findUnique.mockResolvedValue(
      accountRow({ accountChangeHistories: [{ changedAt }] }),
    );
    expect((await service.get(12)).passwordChangedAt).toEqual(changedAt);
    expect(firstArg(findUnique).select.accountChangeHistories).toEqual({
      where: { field: 'PASSWORD' },
      orderBy: [{ changedAt: 'desc' }, { accountChangeHistoryId: 'desc' }],
      take: 1,
      select: { changedAt: true },
    });
  });

  it('본사 제공 동의를 철회했으면 그대로 — false 와 철회 일시', async () => {
    const service = await build();
    const withdrawnAt = new Date('2026-10-15T00:00:00Z');
    findUnique.mockResolvedValue(
      accountRow({
        isHqSharingConsented: false,
        hqSharingWithdrawnAt: withdrawnAt,
      }),
    );
    expect((await service.get(12)).hqSharingConsent).toEqual({
      isConsented: false,
      consentVersion: 'v1.0',
      agreedAt: AGREED_AT,
      withdrawnAt,
      needsReconsent: false,
    });
  });

  it('더는 받아 주지 않는 문구 버전에 동의했으면 다시 묻는다 — 항목 · 목적이 넓어진 뒤(ATT-30)', async () => {
    const service = await build();
    findUnique.mockResolvedValue(
      accountRow({ hqSharingConsentVersion: 'v0.9' }),
    );
    expect((await service.get(12)).hqSharingConsent).toMatchObject({
      isConsented: true,
      consentVersion: 'v0.9',
      needsReconsent: true,
    });
  });

  it('위치정보 동의는 기록에서 판정 (ATT-23 · ATT-26)', async () => {
    const service = await build();
    const pausedAt = new Date('2026-10-10T00:00:00Z');
    findUnique.mockResolvedValue(
      accountRow({
        locationConsents: [
          {
            locationConsentId: 1,
            consentVersion: 'v1.0',
            agreedAt: AGREED_AT,
            pausedAt,
            withdrawnAt: null,
          },
        ],
      }),
    );
    expect((await service.get(12)).locationConsent).toEqual({
      state: 'PAUSED',
      consentVersion: 'v1.0',
      agreedAt: AGREED_AT,
      pausedAt,
      withdrawnAt: null,
      needsReconsent: false,
    });
  });

  it('동의한 약관 버전이 지금 시행 중인 것과 다르면 다시 동의 필요 (ATT-23)', async () => {
    const service = await build();
    findUnique.mockResolvedValue(
      accountRow({
        locationConsents: [
          {
            locationConsentId: 1,
            consentVersion: 'v1.0',
            agreedAt: AGREED_AT,
            pausedAt: null,
            withdrawnAt: null,
          },
        ],
      }),
    );
    termsFindFirst.mockResolvedValue({ version: 'v1.1' });
    expect((await service.get(12)).locationConsent).toMatchObject({
      state: 'AGREED',
      consentVersion: 'v1.0',
      needsReconsent: true,
    });
  });

  it('탈퇴했거나 없는 계정은 401 — /auth/account/me 와 같다', async () => {
    const service = await build();
    findUnique.mockResolvedValue(accountRow({ status: 'WITHDRAWN' }));
    await expect(service.get(12)).rejects.toThrow(UnauthorizedException);
    findUnique.mockResolvedValue(null);
    await expect(service.get(12)).rejects.toThrow(UnauthorizedException);
  });
});
