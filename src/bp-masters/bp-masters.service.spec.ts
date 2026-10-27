import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { BusinessVerificationService } from '../admin-signup/business-verification.service';
import { verifyPassword } from '../auth/password';
import { PLATFORM_ADMIN_MAIL } from '../platform-admins/platform-admin-mail';
import { PrismaService } from '../prisma/prisma.service';
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
    store: { count: jest.Mock };
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
    ...overrides,
  });
  /** 사용 중인 고객 BP 12, 그 BP 마스터 50 */
  const bp = (
    overrides: Record<string, unknown> = {},
    masterOverrides: Record<string, unknown> = {},
  ) => ({
    bpCodeId: 12,
    bpCode: 'BP000012',
    accountStatusCode: 'ACTIVE',
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
    createdAt,
    updatedAt,
    creator: { name: '플랫폼' },
    updater: null,
    adminAccounts: [master(masterOverrides)],
    ...overrides,
  });
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
      store: { count: jest.fn().mockResolvedValue(0) },
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
      expect(listWhere()).toEqual(
        partial({
          accountStatusCode: { in: ['INACTIVE'] },
          bizVerifiedAt: { not: null },
        }),
      );
    });

    it('미인증은 최종 인증일시가 없는 것', async () => {
      await service.list({ page: 1, pageSize: 20, verification: 'UNVERIFIED' });
      expect(listWhere()).toEqual(partial({ bizVerifiedAt: null }));
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
        { OR: [{ bizRegistrationNumber: { contains: '10587' } }] },
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
        tradeName: { contains: 'BP00', mode: 'insensitive' },
      });
    });

    it('검색 기준 없이 숫자 모양이 아닌 검색어는 사업자등록번호로 찾지 않는다 — hangang01 이 01 이 든 번호를 모두 찾지 않게', async () => {
      await service.list({ page: 1, pageSize: 20, keyword: 'hangang01' });
      const [{ OR }] = listWhere().AND as { OR: object[] }[];
      expect(OR.some((c) => 'bizRegistrationNumber' in c)).toBe(false);
    });

    it('검색 기준 없이 숫자 · 하이픈만인 검색어는 숫자만 남겨 사업자등록번호로도 찾는다', async () => {
      await service.list({ page: 1, pageSize: 20, keyword: '105-87' });
      const [{ OR }] = listWhere().AND as { OR: object[] }[];
      expect(OR).toContainEqual({
        bizRegistrationNumber: { contains: '10587' },
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

    it('점포 수는 폐점 · 삭제를 빼고, 하위 관리자는 BA · FM · FA 중 지우지 않은 것', async () => {
      prisma.store.count.mockResolvedValueOnce(3).mockResolvedValueOnce(4);
      prisma.adminAccount.count.mockResolvedValue(2);
      const detail = await service.detail(12);

      expect(prisma.store.count).toHaveBeenCalledWith({
        where: {
          bpCodeId: 12,
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
        data: partial({
          bpCode: 'BP000013',
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: '한강상회',
          createdBy: CALLER,
          updatedBy: CALLER,
        }),
        select: { bpCodeId: true },
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
      expect(prisma.bpCode.create).toHaveBeenCalledWith(
        partial({
          data: partial({
            bizRegistrationNumber: '1058763602',
            bizCeoName: '김하늘',
            bizOpenDate: new Date('2020-03-02T00:00:00.000Z'),
            bizVerifiedAt: anyDate,
          }),
        }),
      );
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
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      await expect(service.create(CALLER, createInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
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

    it('BP 와 BP 마스터를 고치고 바뀐 칸마다 이력을 남긴다', async () => {
      await service.update(CALLER, 12, updateInput);
      expect(prisma.bpCode.update).toHaveBeenCalledWith({
        where: { bpCodeId: 12 },
        data: partial({ tradeName: '한강상회 본점', updatedBy: CALLER }),
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
      expect(bpHistories()).toEqual([
        partial({
          bpCodeId: 12,
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
        partial({ where: partial({ adminAccountId: 50, usedAt: null }) }),
      );
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: 50, passwordHash: '!' },
        data: { isInitialPasswordUnsent: true },
      });
    });

    it('인증 토큰을 실으면 세 값과 인증일시를 바꾸고 그 줄에 「사업자 번호 인증」을 단다', async () => {
      await service.update(CALLER, 12, {
        ...updateInput,
        verificationToken: 't',
      });
      expect(verifications.isBizRegistrationNumberTaken).toHaveBeenCalledWith(
        '1058763602',
        prisma,
        12,
      );
      expect(prisma.bpCode.update).toHaveBeenCalledWith(
        partial({
          data: partial({
            bizRegistrationNumber: '1058763602',
            bizVerifiedAt: anyDate,
          }),
        }),
      );
      expect(bpHistories()).toContainEqual(
        partial({ field: '사업자등록번호', note: '사업자 번호 인증' }),
      );
    });

    it('토큰이 없으면 인증 쪽 세 값은 그대로 둔다', async () => {
      await service.update(CALLER, 12, updateInput);
      const { data } = firstArg<{ data: Record<string, unknown> }>(
        prisma.bpCode.update,
      );
      expect(data).not.toHaveProperty('bizRegistrationNumber');
      expect(data).not.toHaveProperty('bizVerifiedAt');
    });
  });

  describe('changeStatus', () => {
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
    it('조건을 서버에서 다시 보고 못 지우면 409', async () => {
      prisma.store.count.mockResolvedValue(1);
      await expect(service.remove(CALLER, 12)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.bpCode.update).not.toHaveBeenCalled();
    });

    it('BP 와 BP 마스터를 함께 논리 삭제하고 이력을 남긴다', async () => {
      await service.remove(CALLER, 12);
      expect(prisma.store.count).toHaveBeenCalledWith({
        where: { bpCodeId: 12, isDeleted: false },
      });
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

  describe('excel', () => {
    it('1만 건 이상이면 400 이고 1분 제한에 세지 않는다', async () => {
      prisma.bpCode.count.mockResolvedValue(10_000);
      await expect(service.excel(CALLER, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      prisma.bpCode.count.mockResolvedValue(1);
      await expect(service.excel(CALLER, {})).resolves.toEqual(
        partial({
          fileName: expect.stringMatching(/^BP목록_\d{8}\.xlsx$/) as string,
        }),
      );
    });

    it('한 사람 1분에 한 번 — 다시 받으면 429', async () => {
      await service.excel(CALLER, {});
      const error = await service.excel(CALLER, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      // 다른 사람은 받을 수 있다.
      await expect(service.excel(2, {})).resolves.toBeDefined();
    });

    it('목록과 같은 조건 · 순서로 전부 담는다', async () => {
      await service.excel(CALLER, { statuses: ['ACTIVE'] });
      const { where, orderBy, take } = firstArg<{
        where: Prisma.BpCodeWhereInput;
        orderBy: unknown;
        take?: number;
      }>(prisma.bpCode.findMany);
      expect(where).toEqual(partial({ accountStatusCode: { in: ['ACTIVE'] } }));
      expect(orderBy).toEqual([{ createdAt: 'desc' }, { bpCodeId: 'desc' }]);
      expect(take).toBeUndefined();
    });
  });
});
