import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { BusinessVerificationService } from '../admin-signup/business-verification.service';
import { verifyPassword } from '../auth/password';
import { PLATFORM_ADMIN_MAIL } from '../platform-admins/platform-admin-mail';
import { PrismaService } from '../prisma/prisma.service';
import { STORE_CODE_TX } from '../stores/next-store-code';
import { BpMastersService } from './bp-masters.service';

// jest 의 비대칭 매처 · mock.calls 는 any 다. 객체 안에 두거나 꺼내 쓸 때 lint 가 막지 않게 타입을 붙인다.
const partial = (o: object) => expect.objectContaining(o) as object;
const anyDate = expect.any(Date) as Date;
const firstArg = <T>(mock: jest.Mock, i = 0): T =>
  (mock.mock.calls[i] as unknown[])[0] as T;
type Where = { where: Record<string, unknown> };
type ListWhere = { where: Prisma.BpCodeWhereInput };

// 규칙의 경계만 목으로 본다. 잠금 · 동시 처리 · SQL(이력 합치기)은 DB 로만 증명된다(e2e).
describe('BpMastersService', () => {
  let service: BpMastersService;
  let mail: { send: jest.Mock };
  let verifications: {
    verify: jest.Mock;
    readToken: jest.Mock;
    isBizRegistrationNumberTaken: jest.Mock;
  };
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    bpCode: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    adminAccount: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    store: {
      count: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    storeBusinessProfile: { create: jest.Mock; update: jest.Mock };
    staffMember: { count: jest.Mock };
    facility: { count: jest.Mock };
    storeChangeHistory: { createMany: jest.Mock };
    roleGroup: { findFirst: jest.Mock };
    codeGroup: { findMany: jest.Mock };
    codeItem: { findMany: jest.Mock; createMany: jest.Mock };
    temporaryPassword: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
    bpChangeHistory: { createMany: jest.Mock; count: jest.Mock };
    adminChangeHistory: { createMany: jest.Mock; count: jest.Mock };
  };

  const CALLER = 1;
  const createdAt = new Date('2026-10-01T00:00:00Z');
  const updatedAt = new Date('2026-10-20T00:00:00Z');
  const master = (overrides: Record<string, unknown> = {}) => ({
    adminAccountId: 50,
    loginId: 'hangang01',
    name: '김하늘',
    phone: '01012345678',
    email: 'ceo@hangang.test',
    joinPathCode: 'PLATFORM_REGISTERED',
    accountStatusCode: 'ACTIVE',
    statusChangedAt: null,
    lastLoginAt: null,
    termsAgreedAt: null,
    isPasswordChangeRequired: true,
    isInitialPasswordUnsent: false,
    withdrawReasonCode: null,
    withdrawReasonDetail: null,
    ...overrides,
  });
  /** 본사 사업자정보 칸 — BP 상호명 · 사업자정보는 본사 점포에 있다(2026-11-17). */
  const HQ_KEYS = [
    'tradeName',
    'bizRegistrationNumber',
    'bizCeoName',
    'bizOpenDate',
    'bizCeoPhone',
    'bizCeoEmail',
    'bizZipCode',
    'bizAddress',
    'bizAddressDetail',
    'bizCategory',
    'bizItem',
    'bizVerifiedAt',
    'latitude',
    'longitude',
    'isLocationApplied',
  ];
  /** 사용 중인 고객 BP 12, 그 BP 마스터 50, 본사 점포 120 */
  const bp = (
    overrides: Record<string, unknown> = {},
    masterOverrides: Record<string, unknown> = {},
  ) => {
    const hq: Record<string, unknown> = {
      tradeName: '한강상회',
      bizRegistrationNumber: null,
      bizCeoName: null,
      bizOpenDate: null,
      bizCeoPhone: null,
      bizCeoEmail: null,
      bizZipCode: null,
      bizAddress: null,
      bizAddressDetail: null,
      bizCategory: null,
      bizItem: null,
      bizVerifiedAt: null,
      latitude: null,
      longitude: null,
      isLocationApplied: true,
    };
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(overrides))
      (HQ_KEYS.includes(k) ? hq : rest)[k] = v;
    const { tradeName, latitude, longitude, isLocationApplied, ...biz } = hq;
    return {
      bpCodeId: 12,
      bpCode: 'BP000012',
      accountStatusCode: 'ACTIVE',
      stores: [
        {
          storeId: 120,
          latitude,
          longitude,
          isLocationApplied,
          storeStatusCode: 'NOT_OPERATING',
          businessProfile: { bizTradeName: tradeName, ...biz, updatedAt },
        },
      ],
      createdAt,
      updatedAt,
      creator: { name: '플랫폼' },
      updater: null,
      adminAccounts: [master(masterOverrides)],
      ...rest,
    };
  };
  const createInput = {
    loginId: 'hangang01',
    name: '김하늘',
    phone: '01012345678',
    email: 'ceo@hangang.test',
    tradeName: '한강상회',
  };

  beforeEach(async () => {
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
    verifications = {
      verify: jest.fn().mockResolvedValue('token-1'),
      readToken: jest.fn().mockResolvedValue({
        bizRegistrationNumber: '1058763602',
        bizCeoName: '김하늘',
        bizOpenDate: '2020-03-02',
      }),
      isBizRegistrationNumberTaken: jest.fn().mockResolvedValue(false),
    };
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      bpCode: {
        findFirst: jest.fn().mockResolvedValue(bp()),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ bpCodeId: 13 }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ adminAccountId: 51 }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ updatedAt }),
      },
      store: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({ storeId: 130, storeCode: 'ST000130' }),
        update: jest.fn().mockResolvedValue({}),
      },
      storeBusinessProfile: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      staffMember: { count: jest.fn().mockResolvedValue(0) },
      facility: { count: jest.fn().mockResolvedValue(0) },
      storeChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      roleGroup: { findFirst: jest.fn().mockResolvedValue({ roleGroupId: 2 }) },
      codeGroup: { findMany: jest.fn().mockResolvedValue([]) },
      codeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      temporaryPassword: {
        create: jest.fn().mockResolvedValue({ temporaryPasswordId: 77 }),
        findFirst: jest.fn().mockResolvedValue({ temporaryPasswordId: 77 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      bpChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      adminChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: typeof prisma) => Promise<unknown>)(prisma),
    );
    service = await build({ mail, webUrl: 'https://admin.whale.test' });
  });

  /** 발송 수단을 골라 서비스를 만든다. null 은 메일 설정이 없는 환경이다. */
  const build = async (sender: object | null) => {
    const module = await Test.createTestingModule({
      providers: [
        BpMastersService,
        { provide: PrismaService, useValue: prisma },
        { provide: PLATFORM_ADMIN_MAIL, useValue: sender },
        { provide: BusinessVerificationService, useValue: verifications },
      ],
    }).compile();
    return module.get(BpMastersService);
  };

  /** 본사 점포 이력(store_change_histories) — BP 상호명 · 사업자정보 변경은 여기에 남는다(설계 D5). */
  const hqHistories = () =>
    prisma.storeChangeHistory.createMany.mock.calls.flatMap(
      ([arg]: [{ data: object[] }]) => arg.data,
    );

  const bpHistories = () =>
    prisma.bpChangeHistory.createMany.mock.calls.flatMap(
      ([arg]: [{ data: object[] }]) => arg.data,
    );
  const accountHistories = () =>
    prisma.adminChangeHistory.createMany.mock.calls.flatMap(
      ([arg]: [{ data: object[] }]) => arg.data,
    );

  describe('list', () => {
    const listWhere = () => firstArg<ListWhere>(prisma.bpCode.findMany).where;

    it('고객 BP 중 지우지 않고 BP 마스터가 있는 것만, 등록 일시 최신순', async () => {
      prisma.bpCode.findMany.mockResolvedValue([bp()]);
      prisma.bpCode.count.mockResolvedValue(1);
      const result = await service.list({ page: 2, pageSize: 50 });

      expect(prisma.bpCode.findMany).toHaveBeenCalledWith(
        partial({
          orderBy: [{ createdAt: 'desc' }, { bpCodeId: 'desc' }],
          skip: 50,
          take: 50,
        }),
      );
      expect(listWhere()).toEqual(
        partial({
          isPlatform: false,
          isDeleted: false,
          adminAccounts: { some: { roleTypeCode: 'BM', isDeleted: false } },
        }),
      );
      expect(result).toEqual({
        items: [
          {
            bpCodeId: 12,
            bpCode: 'BP000012',
            loginId: 'hangang01',
            name: '김하늘',
            phone: '01012345678',
            email: 'ceo@hangang.test',
            accountStatus: 'ACTIVE',
            tradeName: '한강상회',
            bizRegistrationNumber: null,
            joinPath: 'PLATFORM_REGISTERED',
            createdAt,
            createdByName: '플랫폼',
          },
        ],
        total: 1,
      });
    });

    it('count 는 목록과 같은 where 로 센다', async () => {
      await service.list({
        page: 1,
        pageSize: 20,
        statuses: ['INACTIVE'],
        verification: 'VERIFIED',
      });
      expect(firstArg<ListWhere>(prisma.bpCode.count).where).toEqual(
        listWhere(),
      );
      // 인증 여부는 본사 점포 사업자정보에 있다(2026-11-17).
      expect(listWhere()).toEqual(
        partial({
          accountStatusCode: { in: ['INACTIVE'] },
          stores: {
            some: {
              isHq: true,
              isDeleted: false,
              businessProfile: { bizVerifiedAt: { not: null } },
            },
          },
        }),
      );
    });

    it('미인증은 본사에 최종 인증일시가 없는 것', async () => {
      await service.list({ page: 1, pageSize: 20, verification: 'UNVERIFIED' });
      expect(listWhere()).toEqual(
        partial({
          NOT: {
            stores: {
              some: {
                isHq: true,
                isDeleted: false,
                businessProfile: { bizVerifiedAt: { not: null } },
              },
            },
          },
        }),
      );
    });

    it('탈퇴 BP 는 이름 · 연락처 · 이메일을 내지 않는다', async () => {
      prisma.bpCode.findMany.mockResolvedValue([
        bp({ accountStatusCode: 'WITHDRAWN' }),
      ]);
      const { items } = await service.list({ page: 1, pageSize: 20 });
      expect(items[0]).toEqual(
        partial({
          accountStatus: 'WITHDRAWN',
          loginId: 'hangang01',
          name: null,
          phone: null,
          email: null,
        }),
      );
    });

    it('아이디+이름 검색 — 이름은 탈퇴하지 않은 BP 에서만 맞춘다', async () => {
      await service.list({
        page: 1,
        pageSize: 20,
        searchType: 'LOGIN_ID_NAME',
        keyword: '하늘',
      });
      const contains = { contains: '하늘', mode: 'insensitive' };
      expect(listWhere().AND).toEqual([
        {
          OR: [
            {
              adminAccounts: {
                some: {
                  roleTypeCode: 'BM',
                  isDeleted: false,
                  loginId: contains,
                },
              },
            },
            {
              accountStatusCode: { not: 'WITHDRAWN' },
              adminAccounts: {
                some: { roleTypeCode: 'BM', isDeleted: false, name: contains },
              },
            },
          ],
        },
      ]);
    });

    it('사업자등록번호 검색은 숫자만 남겨 맞춘다', async () => {
      await service.list({
        page: 1,
        pageSize: 20,
        searchType: 'BIZ_REGISTRATION_NUMBER',
        keyword: '105-87',
      });
      expect(listWhere().AND).toEqual([
        {
          OR: [
            {
              stores: {
                some: {
                  isHq: true,
                  isDeleted: false,
                  businessProfile: {
                    bizRegistrationNumber: { contains: '10587' },
                  },
                },
              },
            },
          ],
        },
      ]);
    });

    it('검색 기준 없이 검색어만 주면 BP 코드 · 아이디+이름 · 상호명 어디든 맞으면 나온다', async () => {
      await service.list({ page: 1, pageSize: 20, keyword: 'BP00' });
      const [{ OR }] = listWhere().AND as { OR: object[] }[];
      // 아이디+이름은 두 줄이다(이름은 탈퇴하지 않은 BP 만).
      expect(OR).toHaveLength(4);
      expect(OR).toContainEqual({
        bpCode: { contains: 'BP00', mode: 'insensitive' },
      });
      expect(OR).toContainEqual({
        stores: {
          some: {
            isHq: true,
            isDeleted: false,
            businessProfile: {
              bizTradeName: { contains: 'BP00', mode: 'insensitive' },
            },
          },
        },
      });
    });

    it('검색 기준 없이 숫자 모양이 아닌 검색어는 사업자등록번호로 찾지 않는다 — hangang01 이 01 이 든 번호를 모두 찾지 않게', async () => {
      await service.list({ page: 1, pageSize: 20, keyword: 'hangang01' });
      const [{ OR }] = listWhere().AND as { OR: object[] }[];
      expect(JSON.stringify(OR)).not.toContain('bizRegistrationNumber');
    });

    it('검색 기준 없이 숫자 · 하이픈만인 검색어는 숫자만 남겨 사업자등록번호로도 찾는다', async () => {
      await service.list({ page: 1, pageSize: 20, keyword: '105-87' });
      const [{ OR }] = listWhere().AND as { OR: object[] }[];
      expect(OR).toContainEqual({
        stores: {
          some: {
            isHq: true,
            isDeleted: false,
            businessProfile: { bizRegistrationNumber: { contains: '10587' } },
          },
        },
      });
    });
  });

  describe('detail', () => {
    it('지웠거나 플랫폼 BP 면 404 — 고객 BP · 지우지 않은 것만 찾는다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(service.detail(12)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(firstArg<Where>(prisma.bpCode.findFirst).where).toEqual(
        partial({ bpCodeId: 12, isPlatform: false, isDeleted: false }),
      );
    });

    it('BP 마스터가 없는 BP 도 404', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(bp({ adminAccounts: [] }));
      await expect(service.detail(12)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('점포 수는 본사 · 폐점 · 삭제를 빼고, 하위 관리자는 BA · FM · FA 중 지우지 않은 것', async () => {
      prisma.store.count.mockResolvedValueOnce(3).mockResolvedValueOnce(4);
      prisma.adminAccount.count.mockResolvedValue(2);
      const detail = await service.detail(12);

      expect(prisma.store.count).toHaveBeenCalledWith({
        where: {
          bpCodeId: 12,
          isHq: false,
          isDeleted: false,
          storeStatusCode: { not: 'CLOSED' },
        },
      });
      expect(prisma.adminAccount.count).toHaveBeenCalledWith({
        where: {
          bpCodeId: 12,
          isDeleted: false,
          roleTypeCode: { in: ['BA', 'FM', 'FA'] },
        },
      });
      expect(detail).toEqual(
        partial({
          adminAccountId: 50,
          storeCount: 3,
          subAdminCount: 2,
          updatedAt,
          updatedByName: null,
        }),
      );
    });

    it('로그인 전 · 하위 관리자 · 점포가 없는 사용 BP 는 지울 수 있다', async () => {
      const { deletion } = await service.detail(12);
      expect(deletion).toEqual({ isDeletable: true, reasons: [] });
    });

    it('지울 수 없는 이유를 모두 든다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({}, { lastLoginAt: new Date() }),
      );
      prisma.adminAccount.count.mockResolvedValue(1);
      prisma.store.count.mockResolvedValue(1);
      const { deletion } = await service.detail(12);
      expect(deletion.isDeletable).toBe(false);
      expect(deletion.reasons).toHaveLength(3);
    });

    it('탈퇴한 BP 는 지울 수 없고 개인정보를 내지 않는다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'WITHDRAWN', bizCeoPhone: '0212345678' }),
      );
      const detail = await service.detail(12);
      expect(detail.deletion.isDeletable).toBe(false);
      // 대표자 연락처 · 이메일도 탈퇴 때 지우는 개인정보다(bp_codes 칸 설명).
      expect(detail).toEqual(
        partial({
          name: null,
          phone: null,
          email: null,
          bizCeoPhone: null,
          bizCeoEmail: null,
        }),
      );
    });

    it('탈퇴하지 않은 BP 는 탈퇴 정보가 null', async () => {
      expect((await service.detail(12)).withdrawal).toBeNull();
    });

    it('탈퇴한 BP 는 탈퇴 일시 · 사유 한글 · 직접 입력을 싣는다', async () => {
      const withdrawnAt = new Date('2026-10-20T01:00:00Z');
      prisma.bpCode.findFirst.mockResolvedValue(
        bp(
          { accountStatusCode: 'WITHDRAWN' },
          {
            // 탈퇴는 이름 · 연락처 · 이메일을 지운다 — 실제 탈퇴 행 그대로.
            name: null,
            phone: null,
            email: null,
            statusChangedAt: withdrawnAt,
            withdrawReasonCode: 'WD_INPUT',
            withdrawReasonDetail: '매장 정리',
          },
        ),
      );
      expect((await service.detail(12)).withdrawal).toEqual({
        withdrawnAt,
        reasonLabel: '직접입력',
        reasonDetail: '매장 정리',
      });
    });

    it('표에 없는 사유 코드는 코드 그대로, 직접 입력이 없으면 null', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp(
          { accountStatusCode: 'WITHDRAWN' },
          { withdrawReasonCode: 'WD_NEW', withdrawReasonDetail: null },
        ),
      );
      expect((await service.detail(12)).withdrawal).toEqual(
        partial({ reasonLabel: 'WD_NEW', reasonDetail: null }),
      );
    });

    it('개업일자는 YYYY-MM-DD', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ bizOpenDate: new Date('2020-03-02T00:00:00Z') }),
      );
      expect((await service.detail(12)).bizOpenDate).toBe('2020-03-02');
    });
  });

  describe('histories', () => {
    it('없는 BP 는 404', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(
        service.histories(12, { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('탈퇴한 BP 는 409 — 이력에 탈퇴 전 개인정보가 남아 있다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'WITHDRAWN' }),
      );
      await expect(
        service.histories(12, { page: 1, pageSize: 20 }),
      ).rejects.toThrow(
        new ConflictException('탈퇴한 BP는 변경 이력을 볼 수 없습니다.'),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('BP 이력과 BP 마스터 계정 이력을 합쳐 센다', async () => {
      prisma.bpChangeHistory.count.mockResolvedValue(3);
      prisma.adminChangeHistory.count.mockResolvedValue(2);
      prisma.$queryRaw.mockResolvedValue([
        {
          changed_at: updatedAt,
          field: '상호명',
          before_value: '한강',
          after_value: '한강상회',
          changed_by_name: '플랫폼',
          note: null,
        },
      ]);
      const result = await service.histories(12, { page: 1, pageSize: 20 });
      expect(prisma.bpChangeHistory.count).toHaveBeenCalledWith({
        where: { bpCodeId: 12 },
      });
      expect(prisma.adminChangeHistory.count).toHaveBeenCalledWith({
        where: { adminAccountId: 50 },
      });
      expect(result).toEqual({
        items: [
          {
            changedAt: updatedAt,
            field: '상호명',
            beforeValue: '한강',
            afterValue: '한강상회',
            changedByName: '플랫폼',
            note: null,
          },
        ],
        total: 5,
      });
    });
  });

  describe('isLoginIdAvailable', () => {
    it('대소문자를 가리지 않고 삭제 · 탈퇴한 계정까지 본다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({ adminAccountId: 9 });
      await expect(service.isLoginIdAvailable('HanGang01')).resolves.toBe(
        false,
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: { loginId: { equals: 'HanGang01', mode: 'insensitive' } },
        select: { adminAccountId: true },
      });
    });
  });

  describe('isEmailAvailable', () => {
    it('저장 409 와 같은 규칙 — 지우지 않았고 탈퇴하지 않은 관리자 계정 전체에서 찾는다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({ adminAccountId: 9 });
      await expect(service.isEmailAvailable('ceo@hangang.kr')).resolves.toBe(
        false,
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
        where: {
          email: 'ceo@hangang.kr',
          isDeleted: false,
          accountStatusCode: { not: 'WITHDRAWN' },
        },
        select: { adminAccountId: true },
      });
    });

    it('주인이 없으면 쓸 수 있다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);
      await expect(service.isEmailAvailable('new@hangang.kr')).resolves.toBe(
        true,
      );
    });
  });

  describe('verifyBusiness', () => {
    const identity = {
      bizRegistrationNumber: '1058763602',
      bizCeoName: '김하늘',
      bizOpenDate: '2020-03-02',
    };

    it('등록 — 제외할 BP 없이 확인한다', async () => {
      await expect(service.verifyBusiness(CALLER, identity)).resolves.toEqual({
        verificationToken: 'token-1',
      });
      expect(verifications.verify).toHaveBeenCalledWith(identity, undefined);
    });

    it('수정 — 자기 BP 를 중복에서 뺀다', async () => {
      await service.verifyBusiness(CALLER, { ...identity, bpCodeId: 12 });
      expect(verifications.verify).toHaveBeenCalledWith(identity, 12);
    });

    it('수정 중인 BP 가 없거나 탈퇴했으면 국세청을 부르지 않는다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'WITHDRAWN' }),
      );
      await expect(
        service.verifyBusiness(CALLER, { ...identity, bpCodeId: 12 }),
      ).rejects.toBeInstanceOf(ConflictException);
      prisma.bpCode.findFirst.mockResolvedValue(null);
      await expect(
        service.verifyBusiness(CALLER, { ...identity, bpCodeId: 12 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(verifications.verify).not.toHaveBeenCalled();
    });

    it('한 관리자가 한 시간에 10번을 넘기면 429', async () => {
      for (let i = 0; i < 10; i++)
        await service.verifyBusiness(CALLER, identity);
      const error = await service
        .verifyBusiness(CALLER, identity)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    });
  });

  describe('create', () => {
    // 본사 점포 생성이 점포코드 잠금 줄에 서므로 점포 등록과 같은 트랜잭션 시간을 쓴다.
    it('등록 트랜잭션은 점포 등록과 같은 시간(STORE_CODE_TX)을 쓴다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      await service.create(CALLER, createInput);
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        STORE_CODE_TX,
      );
    });

    it('트랜잭션 시간을 넘기면(P2028) 503', async () => {
      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('timeout', {
          code: 'P2028',
          clientVersion: 'x',
        }),
      );
      await expect(service.create(CALLER, createInput)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('아이디가 이미 있으면 409', async () => {
      prisma.adminAccount.findFirst.mockResolvedValueOnce({
        adminAccountId: 9,
      });
      await expect(service.create(CALLER, createInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.bpCode.create).not.toHaveBeenCalled();
    });

    it('이메일이 사용 · 미사용 계정과 겹치면 409', async () => {
      prisma.adminAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ adminAccountId: 9 });
      await expect(service.create(CALLER, createInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenLastCalledWith({
        where: {
          email: 'ceo@hangang.test',
          isDeleted: false,
          accountStatusCode: { not: 'WITHDRAWN' },
        },
        select: { adminAccountId: true },
      });
    });

    it('BP 와 BP 마스터를 한 트랜잭션에서 만들고 초기 비밀번호를 메일로만 보낸다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      await expect(service.create(CALLER, createInput)).resolves.toEqual({
        bpCodeId: 13,
        bpCode: 'BP000013',
        email: 'ceo@hangang.test',
        isMailSent: true,
      });

      expect(prisma.bpCode.create).toHaveBeenCalledWith({
        data: {
          bpCode: 'BP000013',
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          createdBy: CALLER,
          updatedBy: CALLER,
        },
        select: { bpCodeId: true },
      });
      // 상호명은 본사 점포(직영)와 그 사업자정보에 둔다(2026-11-17).
      expect(prisma.store.create).toHaveBeenCalledWith(
        partial({
          data: partial({
            bpCodeId: 13,
            storeTypeCode: 'DIRECT',
            name: '한강상회',
            isHq: true,
            storeStatusCode: 'NOT_OPERATING',
            createdBy: CALLER,
          }),
        }),
      );
      expect(prisma.storeBusinessProfile.create).toHaveBeenCalledWith({
        data: partial({ storeId: 130, bizTradeName: '한강상회' }),
      });
      expect(prisma.adminAccount.create).toHaveBeenCalledWith({
        data: partial({
          loginId: 'hangang01',
          bpCodeId: 13,
          roleTypeCode: 'BM',
          roleGroupId: 2,
          passwordHash: '!',
          isPasswordChangeRequired: true,
          isInitialPasswordUnsent: true,
          joinPathCode: 'PLATFORM_REGISTERED',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
          createdBy: CALLER,
        }),
        select: { adminAccountId: true },
      });
      expect(prisma.roleGroup.findFirst).toHaveBeenCalledWith(
        partial({ where: { roleCode: 'BM000001', isDeleted: false } }),
      );
      expect(prisma.temporaryPassword.create).toHaveBeenCalledWith(
        partial({ data: partial({ adminAccountId: 51, purpose: 'INITIAL' }) }),
      );

      const sent = firstArg<{
        templateCode: string;
        to: string;
        variables: Record<string, string>;
        maskedVariables: string[];
      }>(mail.send);
      expect(sent).toEqual(
        partial({
          templateCode: 'EMAIL_BP_REGISTER',
          to: 'ceo@hangang.test',
          maskedVariables: ['임시비밀번호'],
        }),
      );
      expect(sent.variables).toEqual(
        partial({
          BP이름: '한강상회',
          관리자이름: '김하늘',
          로그인아이디: 'hangang01',
        }),
      );
      // 메일로 보낸 값이 저장한 해시와 맞는다 — 누구도 값을 따로 보지 않는다.
      const { data } = firstArg<{ data: { passwordHash: string } }>(
        prisma.temporaryPassword.create,
      );
      await expect(
        verifyPassword(sent.variables['임시비밀번호'], data.passwordHash),
      ).resolves.toBe(true);
      // 메일이 나간 뒤에야 미발송을 내린다.
      expect(prisma.adminAccount.update).toHaveBeenCalledWith(
        partial({ data: { isInitialPasswordUnsent: false } }),
      );
    });

    it('플랫폼제공 공통코드를 새 BP 로 복사한다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      prisma.codeGroup.findMany.mockResolvedValue([{ groupCode: 'EMP_TYPE' }]);
      prisma.codeItem.findMany.mockResolvedValue([
        {
          groupCode: 'EMP_TYPE',
          itemCode: 'FT',
          label: '정규직',
          status: 'ACTIVE',
          sortOrder: 1,
        },
      ]);
      await service.create(CALLER, createInput);
      expect(prisma.codeItem.createMany).toHaveBeenCalledWith(
        partial({
          data: [partial({ bpCode: 'BP000013', itemCode: 'FT' })],
        }),
      );
    });

    it('인증 토큰을 실으면 그 값으로 사업자정보를 채우고 번호 중복을 트랜잭션 안에서 다시 본다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      await service.create(CALLER, { ...createInput, verificationToken: 't' });
      expect(verifications.readToken).toHaveBeenCalledWith('t');
      expect(verifications.isBizRegistrationNumberTaken).toHaveBeenCalledWith(
        '1058763602',
        prisma,
        undefined,
      );
      expect(prisma.storeBusinessProfile.create).toHaveBeenCalledWith({
        data: partial({
          bizRegistrationNumber: '1058763602',
          bizCeoName: '김하늘',
          bizOpenDate: new Date('2020-03-02T00:00:00.000Z'),
          bizVerifiedAt: anyDate,
        }),
      });
    });

    it('그 사이 같은 번호가 들어왔으면 409', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      verifications.isBizRegistrationNumberTaken.mockResolvedValue(true);
      await expect(
        service.create(CALLER, { ...createInput, verificationToken: 't' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.bpCode.create).not.toHaveBeenCalled();
    });

    it('메일이 실패해도 등록은 남고 미발송으로 보인다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      mail.send.mockRejectedValue(new Error('smtp'));
      await expect(service.create(CALLER, createInput)).resolves.toEqual(
        partial({ isMailSent: false }),
      );
      expect(prisma.adminAccount.update).not.toHaveBeenCalled();
    });

    it('메일 설정이 없는 환경 — 등록은 되고 미발송', async () => {
      service = await build(null);
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      await expect(service.create(CALLER, createInput)).resolves.toEqual(
        partial({ isMailSent: false }),
      );
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('확인과 저장 사이에 같은 아이디 · 이메일이 먼저 들어왔으면 409', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      prisma.adminAccount.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the constraint: `admin_accounts_login_id_key`',
          { code: 'P2002', clientVersion: 'x' },
        ),
      );
      await expect(service.create(CALLER, createInput)).rejects.toThrow(
        new ConflictException('이미 사용 중인 아이디 또는 이메일입니다.'),
      );
    });

    // adapter-pg 가 제약 이름을 싣는 자리(driverAdapterError.cause.constraint.index)로도 가린다.
    it('제약 이름이 driverAdapterError 에 있는 이메일 위반도 409', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      prisma.adminAccount.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
          meta: {
            driverAdapterError: {
              cause: { constraint: { index: 'admin_accounts_email_key' } },
            },
          },
        }),
      );
      await expect(service.create(CALLER, createInput)).rejects.toThrow(
        new ConflictException('이미 사용 중인 아이디 또는 이메일입니다.'),
      );
    });

    // 사업자번호는 DB 고유가 아니다(본사 점포로 옮긴 뒤) — 다른 고유 위반(점포코드 등)을 409 로 숨기지 않는다.
    it('계정이 아닌 고유 위반은 409 로 바꾸지 않고 그대로 던진다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000012' });
      const storeCode = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the constraint: `stores_store_code_key`',
        { code: 'P2002', clientVersion: 'x' },
      );
      prisma.store.create.mockRejectedValue(storeCode);
      await expect(service.create(CALLER, createInput)).rejects.toBe(storeCode);
    });
  });

  describe('update', () => {
    const updateInput = {
      name: '김하늘',
      phone: '01099998888',
      email: 'ceo@hangang.test',
      tradeName: '한강상회 본점',
    };

    it('탈퇴한 BP 는 409', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'WITHDRAWN' }),
      );
      await expect(
        service.update(CALLER, 12, updateInput),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.bpCode.update).not.toHaveBeenCalled();
    });

    it('본사 사업자정보 · BP 마스터를 고치고 바뀐 칸마다 이력을 남긴다 — 상호명 · 사업자정보 이력은 본사 점포에(설계 D5)', async () => {
      await service.update(CALLER, 12, updateInput);
      expect(prisma.storeBusinessProfile.update).toHaveBeenCalledWith({
        where: { storeId: 120 },
        data: partial({ bizTradeName: '한강상회 본점', updatedBy: CALLER }),
      });
      // 본사 점포명도 상호명을 따른다 — 본사는 점포 관리에서 고칠 수 없다.
      expect(prisma.store.update).toHaveBeenCalledWith({
        where: { storeId: 120 },
        data: partial({ name: '한강상회 본점', updatedBy: CALLER }),
      });
      expect(prisma.bpCode.update).toHaveBeenCalledWith({
        where: { bpCodeId: 12 },
        data: { updatedBy: CALLER },
      });
      expect(prisma.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 50 },
        data: {
          name: '김하늘',
          phone: '01099998888',
          email: 'ceo@hangang.test',
          updatedBy: CALLER,
        },
      });
      expect(bpHistories()).toEqual([]);
      expect(hqHistories()).toEqual([
        partial({
          storeId: 120,
          field: '상호명',
          beforeValue: '한강상회',
          afterValue: '한강상회 본점',
          changedBy: CALLER,
        }),
      ]);
      expect(accountHistories()).toEqual([
        partial({
          adminAccountId: 50,
          field: '연락처',
          beforeValue: '01012345678',
          afterValue: '01099998888',
        }),
      ]);
    });

    // 상태 변경(bp_codes → 본사 점포)과 같은 순서로 잠근다 — 반대면 동시에 들어온 두 요청이 교착(40P01)한다.
    it('BP 행을 본사 점포보다 먼저 잠근다 — 상태 변경과 잠금 순서가 같다', async () => {
      await service.update(CALLER, 12, updateInput);
      expect(prisma.bpCode.update.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.storeBusinessProfile.update.mock.invocationCallOrder[0],
      );
    });

    it('계정 칸만 바뀌어도 BP 의 최종수정을 올린다', async () => {
      await service.update(CALLER, 12, {
        ...updateInput,
        tradeName: '한강상회',
      });
      expect(prisma.bpCode.update).toHaveBeenCalledWith(
        partial({ data: partial({ updatedBy: CALLER }) }),
      );
    });

    it('이메일이 다른 계정과 겹치면 409', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({ adminAccountId: 9 });
      await expect(
        service.update(CALLER, 12, { ...updateInput, email: 'x@y.test' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        partial({
          where: partial({
            email: 'x@y.test',
            adminAccountId: { not: 50 },
          }),
        }),
      );
    });

    it('이메일을 바꾸면 옛 주소로 나간 임시 비밀번호를 막고 미발송을 켠다', async () => {
      prisma.temporaryPassword.updateMany.mockResolvedValue({ count: 1 });
      await service.update(CALLER, 12, { ...updateInput, email: 'new@y.test' });
      expect(prisma.temporaryPassword.updateMany).toHaveBeenCalledWith(
        partial({
          where: { adminAccountId: 50, invalidatedAt: null, isDeleted: false },
        }),
      );
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: 50, passwordHash: '!' },
        data: { isInitialPasswordUnsent: true },
      });
    });

    it('인증 토큰을 실으면 본사의 세 값과 인증일시를 바꾸고 본사 점포 이력에 남긴다', async () => {
      await service.update(CALLER, 12, {
        ...updateInput,
        verificationToken: 't',
      });
      expect(verifications.isBizRegistrationNumberTaken).toHaveBeenCalledWith(
        '1058763602',
        prisma,
        12,
      );
      expect(prisma.storeBusinessProfile.update).toHaveBeenCalledWith(
        partial({
          data: partial({
            bizRegistrationNumber: '1058763602',
            bizVerifiedAt: anyDate,
          }),
        }),
      );
      expect(hqHistories()).toContainEqual(
        partial({
          field: '사업자등록번호',
          beforeValue: null,
          afterValue: '1058763602',
        }),
      );
    });

    it('좌표를 실으면 본사 점포에 넣고, 위도 · 경도를 함께 생략하면 그대로 둔다', async () => {
      await service.update(CALLER, 12, {
        ...updateInput,
        latitude: 37.498095,
        longitude: 127.02761,
        isLocationApplied: true,
      });
      expect(prisma.store.update).toHaveBeenCalledWith({
        where: { storeId: 120 },
        data: partial({ latitude: 37.498095, longitude: 127.02761 }),
      });
      prisma.store.update.mockClear();
      await service.update(CALLER, 12, updateInput);
      expect(
        firstArg<{ data: object }>(prisma.store.update).data,
      ).not.toHaveProperty('latitude');
    });

    it('위도만 보내면 400', async () => {
      await expect(
        service.update(CALLER, 12, { ...updateInput, latitude: 37.5 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('토큰이 없으면 인증 쪽 세 값은 그대로 둔다', async () => {
      await service.update(CALLER, 12, updateInput);
      const { data } = firstArg<{ data: Record<string, unknown> }>(
        prisma.storeBusinessProfile.update,
      );
      expect(data).not.toHaveProperty('bizRegistrationNumber');
      expect(data).not.toHaveProperty('bizVerifiedAt');
    });

    // 마이페이지(bp-profile.service)의 clearBusinessVerification 과 같다 — 플랫폼 BP 수정에서도 지울 수 있다.
    describe('clearBusinessVerification 을 실었으면', () => {
      const verifiedBp = () =>
        bp({
          bizRegistrationNumber: '1058763602',
          bizCeoName: '김하늘',
          bizOpenDate: new Date('2020-01-02T00:00:00.000Z'),
          bizVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
        });

      it('토큰과 함께 보내면 400 — 마이페이지와 같은 문구, 아무것도 고치지 않는다', async () => {
        await expect(
          service.update(CALLER, 12, {
            ...updateInput,
            verificationToken: 't',
            clearBusinessVerification: true,
          }),
        ).rejects.toThrow(
          new BadRequestException(
            '사업자정보를 새로 반영하는 것과 지우는 것을 함께 요청할 수 없습니다.',
          ),
        );
        expect(verifications.readToken).not.toHaveBeenCalled();
        expect(prisma.bpCode.update).not.toHaveBeenCalled();
      });

      it('본사의 세 값과 인증일시를 지우고 본사 점포 이력에 남긴다', async () => {
        prisma.bpCode.findFirst.mockResolvedValue(verifiedBp());
        await service.update(CALLER, 12, {
          ...updateInput,
          clearBusinessVerification: true,
        });
        expect(prisma.storeBusinessProfile.update).toHaveBeenCalledWith(
          partial({
            where: { storeId: 120 },
            data: partial({
              bizRegistrationNumber: null,
              bizCeoName: null,
              bizOpenDate: null,
              bizVerifiedAt: null,
            }),
          }),
        );
        for (const [field, beforeValue] of [
          ['사업자등록번호', '1058763602'],
          ['대표자명', '김하늘'],
          ['개업일자', '2020-01-02'],
        ])
          expect(hqHistories()).toContainEqual(
            partial({ field, beforeValue, afterValue: null }),
          );
      });

      // 상태 판정의 다시 읽기(store.findFirst)가 방금 쓴 사업자번호를 돌려주게 한다 — 고정값이면 지우기가 빠져도 통과한다.
      const operatingHqAfterWrite = () =>
        prisma.store.findFirst.mockImplementation(() => {
          const written = (
            prisma.storeBusinessProfile.update.mock.calls as [
              { data: { bizRegistrationNumber?: string | null } },
            ][]
          ).at(-1)?.[0].data;
          return Promise.resolve({
            storeId: 120,
            storeStatusCode: 'OPERATING',
            latitude: 37.5,
            longitude: 127,
            businessProfile: {
              bizRegistrationNumber:
                written && 'bizRegistrationNumber' in written
                  ? written.bizRegistrationNumber
                  : '1058763602',
            },
            bpCode: { accountStatusCode: 'ACTIVE' },
          });
        });

      it('운영 중인 본사는 사업자번호가 없어지면 미운영으로 내리고 「점포상태」 이력을 남긴다', async () => {
        prisma.bpCode.findFirst.mockResolvedValue(verifiedBp());
        operatingHqAfterWrite();
        await service.update(CALLER, 12, {
          ...updateInput,
          clearBusinessVerification: true,
        });
        expect(prisma.store.update).toHaveBeenCalledWith({
          where: { storeId: 120 },
          data: { storeStatusCode: 'NOT_OPERATING', updatedBy: CALLER },
        });
        expect(hqHistories()).toContainEqual(
          partial({
            field: '점포상태',
            beforeValue: '운영',
            afterValue: '미운영',
          }),
        );
      });

      it('지우지 않고 저장하면 운영 중인 본사는 그대로다 — 대조', async () => {
        prisma.bpCode.findFirst.mockResolvedValue(verifiedBp());
        operatingHqAfterWrite();
        await service.update(CALLER, 12, updateInput);
        for (const [arg] of prisma.store.update.mock.calls as [
          { data: object },
        ][])
          expect(arg.data).not.toHaveProperty('storeStatusCode');
      });

      it('false 와 토큰을 함께 보내면 400 이 아니라 토큰을 반영한다', async () => {
        await service.update(CALLER, 12, {
          ...updateInput,
          verificationToken: 't',
          clearBusinessVerification: false,
        });
        expect(prisma.storeBusinessProfile.update).toHaveBeenCalledWith(
          partial({
            data: partial({ bizRegistrationNumber: '1058763602' }),
          }),
        );
      });

      it('이미 인증이 없는 BP 면 바뀌는 것 없이 성공한다 — 사업자정보 이력도, 미운영 본사의 상태 변경도 없다', async () => {
        prisma.store.findFirst.mockResolvedValue({
          storeId: 120,
          storeStatusCode: 'NOT_OPERATING',
          latitude: null,
          longitude: null,
          businessProfile: { bizRegistrationNumber: null },
          bpCode: { accountStatusCode: 'ACTIVE' },
        });
        await service.update(CALLER, 12, {
          ...updateInput,
          tradeName: '한강상회',
          clearBusinessVerification: true,
        });
        expect(hqHistories()).toEqual([]);
        for (const [arg] of prisma.store.update.mock.calls as [
          { data: object },
        ][])
          expect(arg.data).not.toHaveProperty('storeStatusCode');
      });
    });
  });

  describe('changeStatus', () => {
    it('미사용으로 바꾸면 운영 중인 본사도 미운영으로 내리고 본사 점포 이력을 남긴다', async () => {
      prisma.store.findFirst.mockResolvedValue({
        storeId: 120,
        storeStatusCode: 'OPERATING',
        latitude: 37.5,
        longitude: 127,
        businessProfile: { bizRegistrationNumber: '1058763602' },
        bpCode: { accountStatusCode: 'INACTIVE' },
      });
      await service.changeStatus(CALLER, 12, 'INACTIVE');
      expect(prisma.store.update).toHaveBeenCalledWith({
        where: { storeId: 120 },
        data: { storeStatusCode: 'NOT_OPERATING', updatedBy: CALLER },
      });
      expect(hqHistories()).toEqual([
        partial({
          field: '점포상태',
          beforeValue: '운영',
          afterValue: '미운영',
        }),
      ]);
    });

    it('다시 사용으로 바꾸면 사업자번호 · 좌표를 갖춘 미운영 본사를 운영으로 올리고 본사 점포 이력을 남긴다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'INACTIVE' }),
      );
      prisma.store.findFirst.mockResolvedValue({
        storeId: 120,
        storeStatusCode: 'NOT_OPERATING',
        latitude: 37.5,
        longitude: 127,
        businessProfile: { bizRegistrationNumber: '1058763602' },
        bpCode: { accountStatusCode: 'ACTIVE' },
      });
      await service.changeStatus(CALLER, 12, 'ACTIVE');
      expect(prisma.store.findFirst).toHaveBeenCalledWith(
        partial({ where: { bpCodeId: 12, isHq: true, isDeleted: false } }),
      );
      expect(prisma.store.update).toHaveBeenCalledWith({
        where: { storeId: 120 },
        data: { storeStatusCode: 'OPERATING', updatedBy: CALLER },
      });
      expect(hqHistories()).toEqual([
        partial({
          field: '점포상태',
          beforeValue: '미운영',
          afterValue: '운영',
        }),
      ]);
    });

    it('탈퇴한 BP 는 409', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'WITHDRAWN' }),
      );
      await expect(
        service.changeStatus(CALLER, 12, 'INACTIVE'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('이미 그 상태면 아무것도 쓰지 않는다', async () => {
      await service.changeStatus(CALLER, 12, 'ACTIVE');
      expect(prisma.bpCode.updateMany).not.toHaveBeenCalled();
      expect(prisma.bpChangeHistory.createMany).not.toHaveBeenCalled();
    });

    it('미사용 — BP 와 그 BP 의 사용 중 관리자 계정을 모두 내린다', async () => {
      prisma.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: 50, roleTypeCode: 'BM' },
        { adminAccountId: 60, roleTypeCode: 'BA' },
      ]);
      await service.changeStatus(CALLER, 12, 'INACTIVE');

      expect(prisma.bpCode.updateMany).toHaveBeenCalledWith({
        where: { bpCodeId: 12, accountStatusCode: 'ACTIVE' },
        data: { accountStatusCode: 'INACTIVE', updatedBy: CALLER },
      });
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: { in: [50, 60] } },
        data: {
          accountStatusCode: 'INACTIVE',
          statusChangedAt: anyDate,
          updatedBy: CALLER,
        },
      });
      expect(firstArg<Where>(prisma.adminAccount.findMany).where).toEqual({
        bpCodeId: 12,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      });
      expect(bpHistories()).toEqual([
        partial({
          field: 'BP 상태',
          beforeValue: '사용',
          afterValue: '미사용',
        }),
      ]);
      // BP 마스터의 상태 변경은 BP 이력 한 줄로 보인다 — 하위 계정만 계정 이력에 남긴다.
      expect(accountHistories()).toEqual([
        partial({ adminAccountId: 60, field: '계정 상태' }),
      ]);
    });

    it('사용 — BP 와 BP 마스터만 올린다', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'INACTIVE' }),
      );
      await service.changeStatus(CALLER, 12, 'ACTIVE');
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: { in: [50] } },
        data: partial({ accountStatusCode: 'ACTIVE' }),
      });
      expect(prisma.adminAccount.findMany).not.toHaveBeenCalled();
    });

    it('그 사이 상태가 바뀌었으면 409', async () => {
      prisma.bpCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.changeStatus(CALLER, 12, 'INACTIVE'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('탈퇴한 BP 는 409', async () => {
      prisma.bpCode.findFirst.mockResolvedValue(
        bp({ accountStatusCode: 'WITHDRAWN' }),
      );
      await expect(service.resetPassword(CALLER, 12)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('메일 설정이 없으면 아무것도 쓰지 않고 503', async () => {
      service = await build(null);
      await expect(service.resetPassword(CALLER, 12)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('기존 비밀번호를 막고 새 1시간짜리를 그 계정 이메일로만 보낸다', async () => {
      await expect(service.resetPassword(CALLER, 12)).resolves.toEqual({
        isMailSent: true,
      });
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 50,
          isDeleted: false,
          email: 'ceo@hangang.test',
        },
        data: {
          passwordHash: '!',
          isPasswordChangeRequired: true,
          isInitialPasswordUnsent: true,
          // 잠긴 계정도 받은 비밀번호로 바로 들어온다(BP 관리자 초기화와 같다)
          failedLoginCount: 0,
          lockExpiresAt: null,
          updatedBy: CALLER,
        },
      });
      expect(prisma.temporaryPassword.create).toHaveBeenCalledWith(
        partial({ data: partial({ adminAccountId: 50, purpose: 'RESET' }) }),
      );
      expect(mail.send).toHaveBeenCalledWith(
        partial({
          templateCode: 'EMAIL_PASSWORD_RESET',
          to: 'ceo@hangang.test',
        }),
      );
    });

    it('관리자 변경 이력에 값 없이 「비밀번호」 줄을 남긴다(BP 관리자 초기화와 같다)', async () => {
      await service.resetPassword(CALLER, 12);
      expect(prisma.adminChangeHistory.createMany).toHaveBeenCalledWith({
        data: [
          {
            adminAccountId: 50,
            field: '비밀번호',
            beforeValue: null,
            afterValue: '초기화',
            changedBy: CALLER,
          },
        ],
      });
    });

    it('그 사이 이메일이 바뀌었으면 409 — 옛 주소로 보내지 않는다', async () => {
      prisma.adminAccount.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.resetPassword(CALLER, 12)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mail.send).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    // 본사는 「등록된 점포」에 세지 않지만, 본사에 직원 · 시설물이 있으면 쓰인 BP 다 — 함께 지우면 그 자료가 모든 범위에서 사라진다.
    it.each([
      ['직원', 'staffMember'],
      ['시설물', 'facility'],
    ] as const)('본사에 %s 이 있으면 409', async (_, model) => {
      prisma[model].count.mockResolvedValue(1);
      await expect(service.remove(CALLER, 12)).rejects.toThrow(
        '본사에 등록된 직원 · 시설물이 있어 삭제할 수 없습니다.',
      );
      expect(prisma[model].count).toHaveBeenCalledWith({
        where: expect.objectContaining({ storeId: 120 }) as object,
      });
      expect(prisma.bpCode.update).not.toHaveBeenCalled();
    });

    // 본사 직원 · 시설물 등록은 stores 외래키만 확인해 bp_codes 잠금에 막히지 않는다 — 본사 행을 잠근 뒤 세야
    // 그 순간의 등록을 기다렸다 본다(FOR UPDATE 는 외래키의 KEY SHARE · 시설물의 FOR SHARE 와 충돌한다).
    it('본사 행을 FOR UPDATE 로 잠근 뒤 본사 직원 · 시설물을 센다', async () => {
      await service.remove(CALLER, 12);
      const calls = prisma.$queryRaw.mock.calls as [string[], ...unknown[]][];
      const at = calls.findIndex(([sql]) =>
        /FROM stores WHERE store_id = \? FOR UPDATE/.test(sql.join('?')),
      );
      expect(at).toBeGreaterThan(-1);
      expect(calls[at][1]).toBe(120);
      expect(prisma.$queryRaw.mock.invocationCallOrder[at]).toBeLessThan(
        prisma.staffMember.count.mock.invocationCallOrder[0],
      );
      expect(prisma.$queryRaw.mock.invocationCallOrder[at]).toBeLessThan(
        prisma.facility.count.mock.invocationCallOrder[0],
      );
    });

    it('조건을 서버에서 다시 보고 못 지우면 409', async () => {
      prisma.store.count.mockResolvedValue(1);
      await expect(service.remove(CALLER, 12)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.bpCode.update).not.toHaveBeenCalled();
    });

    it('BP 행 → BP 마스터 계정 행 순서로 잠근 뒤 읽는다 — 그 순간의 첫 로그인(lastLoginAt)을 기다렸다 본다', async () => {
      await service.remove(CALLER, 12);
      const locks = (prisma.$queryRaw.mock.calls as [string[]][]).map(([sql]) =>
        sql.join('?'),
      );
      expect(locks[0]).toMatch(
        /FROM bp_codes WHERE bp_code_id = \? FOR UPDATE/,
      );
      expect(locks[1]).toMatch(/FROM admin_accounts[\s\S]*FOR UPDATE/);
      const [, accountLock] = prisma.$queryRaw.mock.invocationCallOrder;
      const [read] = prisma.bpCode.findFirst.mock.invocationCallOrder;
      expect(accountLock).toBeLessThan(read);
    });

    it('BP · BP 마스터 · 본사 점포를 함께 논리 삭제하고 이력을 남긴다 — 「등록된 점포」에 본사는 세지 않는다', async () => {
      await service.remove(CALLER, 12);
      expect(prisma.store.count).toHaveBeenCalledWith({
        where: { bpCodeId: 12, isHq: false, isDeleted: false },
      });
      expect(prisma.store.update).toHaveBeenCalledWith({
        where: { storeId: 120 },
        data: {
          isDeleted: true,
          storeStatusCode: 'CLOSED',
          closedDate: anyDate,
          updatedBy: CALLER,
        },
      });
      expect(hqHistories()).toEqual([
        partial({ storeId: 120, field: '삭제', beforeValue: '한강상회' }),
      ]);
      expect(prisma.bpCode.update).toHaveBeenCalledWith({
        where: { bpCodeId: 12 },
        data: { isDeleted: true, updatedBy: CALLER },
      });
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { bpCodeId: 12, roleTypeCode: 'BM', isDeleted: false },
        data: { isDeleted: true, updatedBy: CALLER },
      });
      expect(bpHistories()).toEqual([
        partial({ field: 'BP', beforeValue: '사용', afterValue: '삭제' }),
      ]);
    });
  });

  // 1분 제한 · 1만 건 기준 · 생성 중 거절 · 이력은 공통 엑셀(ExcelExportsService)이 맡는다 — test/excel-exports.e2e-spec.ts.
  describe('엑셀 — 건수 · 파일', () => {
    it('건수는 목록과 같은 조건으로 센다 — 1만 건이 넘어도 그대로 돌려준다', async () => {
      prisma.bpCode.count.mockResolvedValue(12_480);
      await expect(service.excelCount({ statuses: ['ACTIVE'] })).resolves.toBe(
        12_480,
      );
      const { where } = firstArg<{ where: Prisma.BpCodeWhereInput }>(
        prisma.bpCode.count,
      );
      expect(where).toEqual(partial({ accountStatusCode: { in: ['ACTIVE'] } }));
      expect(prisma.bpCode.findMany).not.toHaveBeenCalled();
    });

    it('파일은 목록과 같은 조건 · 순서로 전부 담는다', async () => {
      const buffer = await service.excelFile({ statuses: ['ACTIVE'] });
      expect(buffer.subarray(0, 2).toString()).toBe('PK');
      const { where, orderBy, take } = firstArg<{
        where: Prisma.BpCodeWhereInput;
        orderBy: unknown;
        take?: number;
      }>(prisma.bpCode.findMany);
      expect(where).toEqual(partial({ accountStatusCode: { in: ['ACTIVE'] } }));
      expect(orderBy).toEqual([{ createdAt: 'desc' }, { bpCodeId: 'desc' }]);
      expect(take).toBeUndefined();
    });

    it('줄은 목록 한 줄과 같은 값이다 — 탈퇴 BP 의 개인정보는 「탈퇴로 삭제됨」, 연락처는 가린다', async () => {
      prisma.bpCode.findMany.mockResolvedValue([
        bp({ bizRegistrationNumber: '1234567890' }),
        bp({
          bpCodeId: 13,
          bpCode: 'BP000013',
          accountStatusCode: 'WITHDRAWN',
        }),
      ]);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        (await service.excelFile({})) as unknown as ArrayBuffer,
      );
      const sheet = workbook.worksheets[0];
      const values = (n: number) =>
        (sheet.getRow(n).values as unknown[]).slice(1);
      expect(values(2)).toEqual([
        'BP000012',
        '한강상회',
        'hangang01',
        '김하늘',
        '사용',
        '010-****-5678',
        'ceo@hangang.test',
        '123-45-67890',
        '플랫폼등록',
        '2026-10-01 09:00',
      ]);
      expect(values(3).slice(3, 7)).toEqual([
        '탈퇴로 삭제됨',
        '탈퇴',
        '탈퇴로 삭제됨',
        '탈퇴로 삭제됨',
      ]);
    });

    // 예약 생성은 요청 뒤 배치가 만든다 — 그 사이 막힌 계정이나 플랫폼 권한을 잃은 계정에는 파일을 만들어 보내지 않는다.
    it('파일을 만들 사람은 지금도 쓸 수 있는 플랫폼 계정이어야 한다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValueOnce({
        roleTypeCode: 'PA',
        bpCode: { isPlatform: true },
      });
      await expect(service.assertExcelCaller(7)).resolves.toBeUndefined();
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            adminAccountId: 7,
            isDeleted: false,
            accountStatusCode: 'ACTIVE',
          },
        }),
      );
    });

    it('미사용 · 탈퇴 · 삭제 계정이면 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValueOnce(null);
      await expect(service.assertExcelCaller(7)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('플랫폼 권한이 아니면(고객 BP 의 계정 · BP 권한) 403', async () => {
      prisma.adminAccount.findFirst.mockResolvedValueOnce({
        roleTypeCode: 'BM',
        bpCode: { isPlatform: false },
      });
      await expect(service.assertExcelCaller(7)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
