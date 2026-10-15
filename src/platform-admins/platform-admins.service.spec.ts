import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { verifyPassword } from '../auth/password';
import type { MenuCaller } from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_ADMIN_MAIL } from './platform-admin-mail';
import { PlatformAdminsService } from './platform-admins.service';

type Where = { where: Record<string, unknown> };
// jest 의 비대칭 매처 · mock.calls 는 any 다. 객체 안에 두거나 꺼내 쓸 때 lint 가 막지 않게 타입을 붙인다.
const partial = (o: object) => expect.objectContaining(o) as object;
const matching = (re: RegExp) => expect.stringMatching(re) as string;
const anyDate = expect.any(Date) as Date;
const firstArg = <T>(mock: jest.Mock): T =>
  (mock.mock.calls[0] as unknown[])[0] as T;
/** tagged template 로 부른 $queryRaw 의 SQL(자리는 ?)과 값 */
const raw = (mock: jest.Mock, i = 0) => {
  const [strings, ...values] = mock.mock.calls[i] as [string[], ...unknown[]];
  return { sql: strings.join('?'), values };
};

// 규칙의 경계만 목으로 본다. 잠금 · 동시 수정은 DB 로만 증명된다.
describe('PlatformAdminsService', () => {
  let service: PlatformAdminsService;
  let mail: { send: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    adminAccount: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    roleGroup: { findFirst: jest.Mock; findMany: jest.Mock };
    bpCode: { findFirst: jest.Mock };
    temporaryPassword: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
    adminChangeHistory: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };

  const pm: MenuCaller = {
    adminAccountId: 1,
    roleTypeCode: 'PM',
    roleGroupId: 10,
  };
  const pa: MenuCaller = {
    adminAccountId: 2,
    roleTypeCode: 'PA',
    roleGroupId: 20,
  };
  const pmGroup = {
    roleGroupId: 10,
    roleCode: 'PM000001',
    name: '플랫폼 마스터',
    roleTypeCode: 'PM',
  };
  const paGroup = {
    roleGroupId: 20,
    roleCode: 'PA000001',
    name: '플랫폼 관리자',
    roleTypeCode: 'PA',
  };
  const updatedAt = new Date('2026-10-13T00:00:00Z');
  /** 수정 · 삭제 · 초기화 대상. 사용 중인 PA, id 5 */
  const target = (overrides: Record<string, unknown> = {}) => ({
    adminAccountId: 5,
    loginId: 'seojun01',
    name: '이서준',
    phone: '01012345678',
    email: 'seojun@whale.test',
    department: null,
    jobTitle: null,
    zipCode: null,
    address: null,
    addressDetail: null,
    roleTypeCode: 'PA',
    roleGroupId: 20,
    roleGroup: paGroup,
    accountStatusCode: 'ACTIVE',
    updatedAt,
    ...overrides,
  });

  beforeEach(async () => {
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm1' }) };
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ adminAccountId: 5 }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ updatedAt }),
      },
      roleGroup: {
        findFirst: jest.fn().mockResolvedValue(paGroup),
        findMany: jest.fn().mockResolvedValue([]),
      },
      bpCode: { findFirst: jest.fn().mockResolvedValue({ bpCodeId: 1 }) },
      temporaryPassword: {
        create: jest.fn().mockResolvedValue({ temporaryPasswordId: 77 }),
        findFirst: jest.fn().mockResolvedValue({ temporaryPasswordId: 77 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adminChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
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

  /** 발송 수단(PLATFORM_ADMIN_MAIL)을 골라 서비스를 만든다. null 은 메일 설정이 없는 환경이다. */
  const build = async (sender: object | null) => {
    const module = await Test.createTestingModule({
      providers: [
        PlatformAdminsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PLATFORM_ADMIN_MAIL, useValue: sender },
      ],
    }).compile();
    return module.get(PlatformAdminsService);
  };

  // main(PR #28): MAIL_* · ADMIN_WEB_URL 이 없어도 api 는 뜬다. 이 메뉴는 메일만 보내지 않는다.
  describe('메일 설정이 없는 환경', () => {
    beforeEach(async () => {
      service = await build(null);
      prisma.adminAccount.findFirst.mockImplementation(({ where }: Where) =>
        Promise.resolve(where.adminAccountId === 5 ? target() : null),
      );
    });

    it('등록은 되고 「초기 비밀번호 미발송」으로 남는다', async () => {
      await expect(
        service.create(pm, {
          loginId: 'seojun01',
          name: '이서준',
          phone: '01012345678',
          email: 'seojun@whale.test',
          roleGroupId: 20,
        }),
      ).resolves.toEqual({ adminAccountId: 5, isMailSent: false });
      expect(mail.send).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    // 초기화는 기존 비밀번호를 지운다. 새 비밀번호를 보낼 길이 없으면 계정이 잠기므로 아무것도 쓰지 않는다.
    it('초기화는 아무것도 쓰지 않고 503', async () => {
      await expect(service.resetPassword(pm, 5)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.temporaryPassword.create).not.toHaveBeenCalled();
      expect(prisma.adminChangeHistory.createMany).not.toHaveBeenCalled();
    });
  });

  const histories = () =>
    prisma.adminChangeHistory.createMany.mock.calls.flatMap(
      ([arg]: [{ data: object[] }]) => arg.data,
    );

  describe('list', () => {
    it('지우지 않은 PM · PA 만, 아이디 · 이름 포함 검색 · 권한 · 상태로 거르고 등록일시 최신순, 미사용 수를 함께 준다', async () => {
      prisma.adminAccount.findMany.mockResolvedValue([
        {
          ...target(),
          lastLoginAt: null,
          createdAt: updatedAt,
          isInitialPasswordUnsent: true,
        },
      ]);
      prisma.adminAccount.count
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(1);

      const result = await service.list({
        keyword: '서준',
        roleGroupId: 20,
        statuses: ['ACTIVE', 'INACTIVE'],
        page: 2,
        pageSize: 20,
      });

      const where = {
        roleTypeCode: { in: ['PM', 'PA'] },
        bpCode: { isPlatform: true },
        isDeleted: false,
        accountStatusCode: { in: ['ACTIVE', 'INACTIVE'] },
        roleGroupId: 20,
        OR: [
          { loginId: { contains: '서준', mode: 'insensitive' } },
          { name: { contains: '서준', mode: 'insensitive' } },
        ],
      };
      expect(prisma.adminAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: [{ createdAt: 'desc' }, { adminAccountId: 'desc' }],
          skip: 20,
          take: 20,
        }),
      );
      expect(prisma.adminAccount.count).toHaveBeenNthCalledWith(1, { where });
      expect(prisma.adminAccount.count).toHaveBeenNthCalledWith(2, {
        where: { ...where, accountStatusCode: 'INACTIVE' },
      });
      expect(result).toMatchObject({
        total: 7,
        inactiveCount: 1,
        items: [
          {
            adminAccountId: 5,
            loginId: 'seojun01',
            roleGroup: paGroup,
            accountStatus: 'ACTIVE',
            isInitialPasswordUnsent: true,
          },
        ],
      });
    });

    it('검색어 · 권한 · 상태를 주지 않으면 사용 · 미사용 전체다', async () => {
      await service.list({ page: 1, pageSize: 20 });

      expect(prisma.adminAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            roleTypeCode: { in: ['PM', 'PA'] },
            bpCode: { isPlatform: true },
            isDeleted: false,
            accountStatusCode: { in: ['ACTIVE', 'INACTIVE'] },
          },
        }),
      );
    });

    // 역할이 고객 BP 계정에 잘못 붙어도(고객 BP 소속 PM · PA) 이 화면의 대상이 아니다.
    it('고객 BP 소속 PM · PA 는 목록에서 빠진다 — 플랫폼 BP 소속만 센다', async () => {
      await service.list({ page: 1, pageSize: 20 });

      for (const call of [
        firstArg<Where>(prisma.adminAccount.findMany),
        firstArg<Where>(prisma.adminAccount.count),
      ])
        expect(call.where).toMatchObject({ bpCode: { isPlatform: true } });
    });
  });

  describe('roleGroups', () => {
    it('플랫폼 BP 의 지우지 않은 PM · PA 권한 그룹 — PM 은 둘 다 본다', async () => {
      prisma.roleGroup.findMany.mockResolvedValue([pmGroup, paGroup]);

      await expect(service.roleGroups(pm)).resolves.toEqual({
        items: [pmGroup, paGroup],
      });
      expect(prisma.roleGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            isDeleted: false,
            roleTypeCode: { in: ['PM', 'PA'] },
            bpCode: { isPlatform: true },
          },
          orderBy: { roleCode: 'asc' },
        }),
      );
    });

    it('PA 에게는 PM 권한 그룹을 빼고 준다', async () => {
      await service.roleGroups(pa);

      expect(prisma.roleGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: partial({ roleTypeCode: { in: ['PA'] } }),
        }),
      );
    });
  });

  describe('isLoginIdAvailable', () => {
    it('삭제한 계정까지 포함해 같은 아이디가 없을 때만 쓸 수 있다', async () => {
      await expect(service.isLoginIdAvailable('seojun01')).resolves.toBe(true);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { loginId: 'seojun01' } }),
      );

      prisma.adminAccount.findFirst.mockResolvedValue({ adminAccountId: 3 });
      await expect(service.isLoginIdAvailable('seojun01')).resolves.toBe(false);
    });
  });

  describe('detail · histories', () => {
    it('지운 · 탈퇴한 계정이나 플랫폼 계정이 아니면(고객 BP 소속 PM · PA 포함) 404', async () => {
      await expect(service.detail(5)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            adminAccountId: 5,
            isDeleted: false,
            roleTypeCode: { in: ['PM', 'PA'] },
            bpCode: { isPlatform: true },
            accountStatusCode: { not: 'WITHDRAWN' },
          },
        }),
      );
    });

    it('상세는 등록자 · 수정자 이름을 함께 준다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({
        ...target(),
        statusChangedAt: null,
        lastLoginAt: null,
        createdAt: updatedAt,
        isInitialPasswordUnsent: false,
        creator: { name: '김마스터' },
        updater: null,
      });

      await expect(service.detail(5)).resolves.toMatchObject({
        adminAccountId: 5,
        roleGroup: paGroup,
        createdByName: '김마스터',
        updatedByName: null,
        updatedAt,
      });
    });

    it('변경 이력은 최신순으로 한 쪽씩 처리자 이름과 함께', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue({ adminAccountId: 5 });
      prisma.adminChangeHistory.findMany.mockResolvedValue([
        {
          changeId: 3,
          field: '계정 상태',
          beforeValue: '사용',
          afterValue: '미사용',
          changedAt: updatedAt,
          changer: { name: '김마스터' },
        },
      ]);
      prisma.adminChangeHistory.count.mockResolvedValue(1);

      await expect(
        service.histories(5, { page: 1, pageSize: 20 }),
      ).resolves.toEqual({
        items: [
          {
            changeId: 3,
            field: '계정 상태',
            beforeValue: '사용',
            afterValue: '미사용',
            changedAt: updatedAt,
            changedByName: '김마스터',
          },
        ],
        total: 1,
      });
      expect(prisma.adminChangeHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { adminAccountId: 5 },
          orderBy: [{ changedAt: 'desc' }, { changeId: 'desc' }],
        }),
      );
    });
  });

  describe('create', () => {
    const input = {
      loginId: 'seojun01',
      name: '이서준',
      phone: '01012345678',
      email: 'SeoJun@Whale.test',
      department: '운영팀',
      roleGroupId: 20,
    };

    it('사용 · 플랫폼등록 계정을 쓸 수 없는 비밀번호로 만들고, 1시간짜리 초기 비밀번호를 메일로만 보낸다', async () => {
      const result = await service.create(pm, input);

      expect(prisma.adminAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: partial({
            loginId: 'seojun01',
            name: '이서준',
            phone: '01012345678',
            email: 'seojun@whale.test',
            department: '운영팀',
            bpCodeId: 1,
            roleGroupId: 20,
            roleTypeCode: 'PA',
            passwordHash: '!',
            isPasswordChangeRequired: true,
            joinPathCode: 'PLATFORM_REGISTERED',
            accountStatusCode: 'ACTIVE',
            // 메일이 나간 뒤에야 내린다 — 그 사이 무엇이 실패해도 「미발송」으로 남는다
            isInitialPasswordUnsent: true,
            createdBy: 1,
            updatedBy: 1,
          }),
        }),
      );
      const temp = firstArg<{
        data: { passwordHash: string; expiresAt: Date };
      }>(prisma.temporaryPassword.create).data;
      expect(temp).toMatchObject({
        adminAccountId: 5,
        purpose: 'INITIAL',
        createdBy: 1,
      });
      expect(temp.passwordHash).toMatch(/^scrypt\$/);
      expect(temp.expiresAt.getTime() - Date.now()).toBeGreaterThan(
        59 * 60_000,
      );
      expect(temp.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
        60 * 60_000,
      );

      const sent = firstArg<{ variables: Record<string, string> }>(mail.send);
      expect(sent).toMatchObject({
        templateCode: 'EMAIL_PLAT_ADMIN_CREATE',
        to: 'seojun@whale.test',
        maskedVariables: ['임시비밀번호'],
        adminAccountId: 5,
        sentBy: 1,
      });
      expect(sent.variables).toEqual({
        관리자이름: '이서준',
        로그인아이디: 'seojun01',
        임시비밀번호: matching(/^[A-Za-z0-9]{12}$/),
        // 바로가기 버튼은 관리자 웹으로 간다(BP 회원가입과 같다)
        링크: 'https://admin.whale.test',
      });
      // 메일로 보낸 값이 저장한 해시와 맞아야 그 비밀번호로 들어올 수 있다
      await expect(
        verifyPassword(sent.variables.임시비밀번호, temp.passwordHash),
      ).resolves.toBe(true);
      // 그 사이 다른 초기화가 이 비밀번호를 무효로 했으면 끄지 않는다 — 새 비밀번호의 메일은 아직 모른다
      // 계정 행을 먼저 잠근다 — 진행 중인 초기화 · 이메일 변경이 끝난 뒤의 상태를 다음 문장이 본다
      const lock = raw(prisma.$queryRaw);
      expect(lock.sql).toMatch(/FOR NO KEY UPDATE/);
      expect(lock.values).toEqual([5]);
      expect(prisma.temporaryPassword.findFirst).toHaveBeenCalledWith({
        where: {
          temporaryPasswordId: 77,
          adminAccountId: 5,
          invalidatedAt: null,
          isDeleted: false,
        },
        select: { temporaryPasswordId: true },
      });
      expect(prisma.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 5 },
        data: { isInitialPasswordUnsent: false },
        select: { updatedAt: true },
      });
      expect(histories()).toEqual([
        {
          adminAccountId: 5,
          field: '계정',
          beforeValue: null,
          afterValue: '사용 · 플랫폼 관리자 PA000001',
          changedBy: 1,
        },
      ]);
      expect(result).toEqual({ adminAccountId: 5, isMailSent: true });
    });

    it('메일이 실패해도 계정은 남기고 초기 비밀번호 미발송으로 표시한다', async () => {
      mail.send.mockRejectedValue(new Error('smtp down'));

      await expect(service.create(pm, input)).resolves.toEqual({
        adminAccountId: 5,
        isMailSent: false,
      });
      // 만들 때 이미 「미발송」이다 — 더 쓸 것이 없다
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    // 메일 오류에는 SMTP 가 돌려준 받는 주소가 들어 있다. MailService 가 가린 것을 다시 찍지 않는다.
    it('SMTP 오류 로그에 오류 원문(받는 주소)을 남기지 않는다', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mail.send.mockRejectedValue(
        Object.assign(new Error('550 rejected <seojun@whale.test>'), {
          code: 'EENVELOPE',
        }),
      );

      await service.create(pm, input);

      const logged = (warn.mock.calls as unknown[][]).flat().join(' ');
      expect(logged).toMatch(/EMAIL_PLAT_ADMIN_CREATE/);
      expect(logged).toMatch(/EENVELOPE/);
      expect(logged).not.toMatch(/seojun@whale\.test/);
      warn.mockRestore();
    });

    // 보내기 전 검증(템플릿 · 변수)에서 난 실패는 MailService 가 남기지 않고 mail_send_logs 에도 없다.
    it('SMTP 전에 난 실패는 원인(메시지)을 남긴다', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mail.send.mockRejectedValue(
        new Error('템플릿 EMAIL_PLAT_ADMIN_CREATE 이(가) 꺼져 있습니다'),
      );

      await service.create(pm, input);

      const logged = (warn.mock.calls as unknown[][]).flat().join(' ');
      expect(logged).toMatch(/꺼져 있습니다/);
      warn.mockRestore();
    });

    // 계정은 이미 만들어졌다. 500 을 주면 화면이 다시 등록하다 아이디 중복 409 를 만난다.
    it('메일이 간 뒤 미발송 해제가 실패해도 만든 계정을 돌려준다 — 「미발송」으로 남는 쪽이 안전하다', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      prisma.$queryRaw.mockRejectedValue(
        new Error('Invalid invocation: { email: "seojun@whale.test" }'),
      );

      await expect(service.create(pm, input)).resolves.toEqual({
        adminAccountId: 5,
        isMailSent: true,
      });
      // Prisma 메시지는 인자를 담는다 — stack 첫 줄로도 새지 않게 뗀다
      const logged = (error.mock.calls as unknown[][]).flat().join(' ');
      expect(logged).toMatch(/미발송 해제/);
      expect(logged).not.toMatch(/seojun@whale\.test/);
      error.mockRestore();
    });

    it('플랫폼 관리자는 플랫폼 마스터 계정을 만들 수 없다(403)', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(pmGroup);

      await expect(
        service.create(pa, { ...input, roleGroupId: 10 }),
      ).rejects.toThrow(
        new ForbiddenException('플랫폼 마스터 계정을 등록할 권한이 없습니다'),
      );
      expect(prisma.adminAccount.create).not.toHaveBeenCalled();
    });

    it('플랫폼 PM · PA 권한 그룹이 아니면 400', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(null);

      await expect(service.create(pm, input)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.roleGroup.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            roleGroupId: 20,
            isDeleted: false,
            roleTypeCode: { in: ['PM', 'PA'] },
            bpCode: { isPlatform: true },
          },
        }),
      );
    });

    it('아이디는 삭제한 계정까지 포함해 겹칠 수 없다(409)', async () => {
      prisma.adminAccount.findFirst.mockImplementation(({ where }: Where) =>
        Promise.resolve(where.loginId ? { adminAccountId: 3 } : null),
      );

      await expect(service.create(pm, input)).rejects.toThrow(
        new ConflictException(
          '이미 사용 중인 아이디입니다. 삭제된 계정의 아이디도 다시 쓸 수 없습니다',
        ),
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { loginId: 'seojun01' } }),
      );
    });

    it('이메일은 지우지 않은 사용 · 미사용 계정과 겹칠 수 없다(409)', async () => {
      prisma.adminAccount.findFirst.mockImplementation(({ where }: Where) =>
        Promise.resolve(where.email ? { adminAccountId: 3 } : null),
      );

      await expect(service.create(pm, input)).rejects.toThrow(
        new ConflictException(
          '사용 중이거나 미사용인 다른 관리자 계정의 이메일입니다',
        ),
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email: 'seojun@whale.test',
            isDeleted: false,
            accountStatusCode: { not: 'WITHDRAWN' },
          },
        }),
      );
    });

    it('확인 뒤 다른 요청이 먼저 같은 아이디 · 이메일로 만들면(P2002) 500 이 아니라 409', async () => {
      prisma.adminAccount.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '7',
        }),
      );

      await expect(service.create(pm, input)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mail.send).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const input = {
      name: '이서준',
      phone: '01099998888',
      email: 'seojun@whale.test',
      department: '운영팀',
      jobTitle: null,
      zipCode: null,
      address: null,
      addressDetail: null,
      roleGroupId: 20,
      accountStatus: 'ACTIVE' as const,
      updatedAt: updatedAt.toISOString(),
    };

    beforeEach(() => {
      prisma.adminAccount.findFirst.mockImplementation(({ where }: Where) =>
        Promise.resolve(where.adminAccountId === 5 ? target() : null),
      );
    });

    it('읽은 뒤 바뀌지 않았을 때만 고치고, 바뀐 항목마다 이력을 한 줄씩 남긴다', async () => {
      await service.update(pm, 5, input);

      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 5,
          // DB 는 µs 까지 저장한다 — 같은 ms 안이면 같은 값으로 본다
          updatedAt: { gte: updatedAt, lt: new Date(updatedAt.getTime() + 1) },
        },
        data: {
          name: '이서준',
          phone: '01099998888',
          email: 'seojun@whale.test',
          department: '운영팀',
          jobTitle: null,
          zipCode: null,
          address: null,
          addressDetail: null,
          roleGroupId: 20,
          roleTypeCode: 'PA',
          accountStatusCode: 'ACTIVE',
          updatedBy: 1,
        },
      });
      expect(histories()).toEqual([
        {
          adminAccountId: 5,
          field: '연락처',
          beforeValue: '01012345678',
          afterValue: '01099998888',
          changedBy: 1,
        },
        {
          adminAccountId: 5,
          field: '소속 부서',
          beforeValue: null,
          afterValue: '운영팀',
          changedBy: 1,
        },
      ]);
    });

    it('다른 사람이 먼저 고쳤으면 저장하지 않고 409', async () => {
      prisma.adminAccount.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.update(pm, 5, input)).rejects.toThrow(
        new ConflictException(
          '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요',
        ),
      );
      expect(prisma.adminChangeHistory.createMany).not.toHaveBeenCalled();
    });

    it('미사용으로 바꾸면 상태 변경 일시를 남기고, 권한을 바꾸면 권한 유형도 그 그룹을 따른다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue({
        ...paGroup,
        roleGroupId: 21,
        roleCode: 'PA000002',
        name: '고객지원 담당',
      });

      await service.update(pm, 5, {
        ...input,
        phone: '01012345678',
        department: null,
        roleGroupId: 21,
        accountStatus: 'INACTIVE',
      });

      const { data } = firstArg<{ data: object }>(
        prisma.adminAccount.updateMany,
      );
      expect(data).toMatchObject({
        roleGroupId: 21,
        roleTypeCode: 'PA',
        accountStatusCode: 'INACTIVE',
        statusChangedAt: anyDate,
      });
      expect(histories()).toEqual([
        expect.objectContaining({
          field: '사용자 권한',
          beforeValue: '플랫폼 관리자 PA000001',
          afterValue: '고객지원 담당 PA000002',
        }),
        expect.objectContaining({
          field: '계정 상태',
          beforeValue: '사용',
          afterValue: '미사용',
        }),
      ]);
    });

    // 마스터 보호 · 마지막 PM 집계 · 권한 선택지가 모두 role_type_code 를 본다. 그룹만 바뀌면 보호가 조용히 깨진다.
    it('플랫폼 마스터가 PA 를 PM 그룹으로 올리면 권한 유형도 PM 이 된다', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(pmGroup);

      await service.update(pm, 5, { ...input, roleGroupId: 10 });

      expect(
        firstArg<{ data: object }>(prisma.adminAccount.updateMany).data,
      ).toMatchObject({ roleGroupId: 10, roleTypeCode: 'PM' });
    });

    it('다른 사용 PM 이 있을 때 PM 을 PA 그룹으로 내리면 권한 유형도 PA 가 된다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        target({ roleTypeCode: 'PM', roleGroupId: 10, roleGroup: pmGroup }),
      );
      prisma.$queryRaw.mockResolvedValue([
        { admin_account_id: 1 },
        { admin_account_id: 5 },
      ]);

      await service.update(pm, 5, { ...input, roleGroupId: 20 });

      expect(
        firstArg<{ data: object }>(prisma.adminAccount.updateMany).data,
      ).toMatchObject({ roleGroupId: 20, roleTypeCode: 'PA' });
    });

    it('없거나 지운 계정이면 404', async () => {
      await expect(service.update(pm, 6, input)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('플랫폼 마스터 계정은 플랫폼 마스터만 고친다(403)', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        target({ roleTypeCode: 'PM', roleGroupId: 10, roleGroup: pmGroup }),
      );

      await expect(
        service.update(pa, 5, { ...input, roleGroupId: 10 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('플랫폼 관리자는 플랫폼 마스터 권한을 줄 수 없다(403)', async () => {
      prisma.roleGroup.findFirst.mockResolvedValue(pmGroup);

      await expect(
        service.update(pa, 5, { ...input, roleGroupId: 10 }),
      ).rejects.toThrow(
        new ForbiddenException('플랫폼 마스터 권한을 줄 권한이 없습니다'),
      );
    });

    it('본인 계정은 기본정보만 — 권한 · 상태를 바꾸려 하면 403', async () => {
      const self = { ...pa, adminAccountId: 5 };

      await expect(
        service.update(self, 5, { ...input, accountStatus: 'INACTIVE' }),
      ).rejects.toThrow(
        new ForbiddenException('본인 계정의 권한 · 상태는 바꿀 수 없습니다'),
      );
      await expect(service.update(self, 5, input)).resolves.toBeUndefined();
    });

    it('이메일을 다른 계정과 겹치게 바꾸면 409', async () => {
      prisma.adminAccount.findFirst.mockImplementation(({ where }: Where) =>
        Promise.resolve(where.email ? { adminAccountId: 3 } : target()),
      );

      await expect(
        service.update(pm, 5, { ...input, email: 'Other@Whale.test' }),
      ).rejects.toThrow(
        new ConflictException('이미 다른 관리자 계정에 등록된 이메일입니다'),
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email: 'other@whale.test',
            isDeleted: false,
            accountStatusCode: { not: 'WITHDRAWN' },
            adminAccountId: { not: 5 },
          },
        }),
      );
    });

    // 메일로 나간 비밀번호는 옛 주소의 주인이 쓸 수 있다. 커밋 뒤 메일이 나가기 전에 바꿔도 마찬가지다.
    it('이메일을 바꾸면 쓰지 않은 임시 비밀번호를 같은 트랜잭션에서 무효로 한다', async () => {
      await service.update(pm, 5, { ...input, email: 'new@whale.test' });

      expect(prisma.temporaryPassword.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 5,
          usedAt: null,
          invalidatedAt: null,
          isDeleted: false,
        },
        data: { invalidatedAt: anyDate, updatedBy: 1 },
      });
    });

    // 등록 · 초기화한 계정의 로그인 수단은 그 임시 비밀번호뿐이다. 무효로 했으면 다시 보내야 한다고 알린다.
    it('이메일을 바꿔 임시 비밀번호를 무효로 했으면 「미발송」을 다시 켠다', async () => {
      prisma.temporaryPassword.updateMany.mockResolvedValue({ count: 1 });

      await service.update(pm, 5, { ...input, email: 'new@whale.test' });

      expect(prisma.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 5 },
        data: { isInitialPasswordUnsent: true },
      });
    });

    it('무효로 할 임시 비밀번호가 없으면 「미발송」은 그대로 둔다', async () => {
      await service.update(pm, 5, { ...input, email: 'new@whale.test' });

      expect(prisma.adminAccount.update).not.toHaveBeenCalled();
    });

    it('이메일이 그대로면 임시 비밀번호를 건드리지 않는다', async () => {
      await service.update(pm, 5, input);

      expect(prisma.temporaryPassword.updateMany).not.toHaveBeenCalled();
    });

    describe('사용 중인 플랫폼 마스터가 한 명은 남아야 한다', () => {
      const pmTarget = () =>
        target({ roleTypeCode: 'PM', roleGroupId: 10, roleGroup: pmGroup });
      const pmInput = { ...input, roleGroupId: 10 };

      beforeEach(() => {
        prisma.adminAccount.findFirst.mockResolvedValue(pmTarget());
        prisma.roleGroup.findFirst.mockResolvedValue(pmGroup);
      });

      it('마지막 사용 PM 을 미사용으로 바꾸면 409', async () => {
        prisma.$queryRaw.mockResolvedValue([{ admin_account_id: 5 }]);

        await expect(
          service.update(pm, 5, { ...pmInput, accountStatus: 'INACTIVE' }),
        ).rejects.toThrow(
          new ConflictException(
            '사용 중인 플랫폼 마스터가 한 명은 있어야 합니다',
          ),
        );
        expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
      });

      it('마지막 사용 PM 을 PA 로 내리면 409', async () => {
        prisma.$queryRaw.mockResolvedValue([{ admin_account_id: 5 }]);
        prisma.roleGroup.findFirst.mockResolvedValue(paGroup);

        await expect(
          service.update(pm, 5, { ...pmInput, roleGroupId: 20 }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('다른 사용 PM 이 있으면 미사용으로 바꿀 수 있다', async () => {
        prisma.$queryRaw.mockResolvedValue([
          { admin_account_id: 1 },
          { admin_account_id: 5 },
        ]);

        await expect(
          service.update(pm, 5, { ...pmInput, accountStatus: 'INACTIVE' }),
        ).resolves.toBeUndefined();
      });

      // FOR UPDATE 는 외래키 확인(updated_by → admin_accounts 의 FOR KEY SHARE)과 충돌해 교착할 수 있다.
      it('사용 중 PM 을 FOR NO KEY UPDATE 로 잠근다', async () => {
        prisma.$queryRaw.mockResolvedValue([
          { admin_account_id: 1 },
          { admin_account_id: 5 },
        ]);

        await service.update(pm, 5, { ...pmInput, accountStatus: 'INACTIVE' });

        const sql = firstArg<string[]>(prisma.$queryRaw).join('?');
        expect(sql).toMatch(/FOR NO KEY UPDATE/);
      });

      // 고객 BP 소속 PM 은 이 화면을 쓰지 못하므로 남은 마스터로 세면 마지막 PM 을 내릴 수 있게 된다.
      it('남은 사용 PM 은 플랫폼 BP 소속만 센다', async () => {
        prisma.$queryRaw.mockResolvedValue([
          { admin_account_id: 1 },
          { admin_account_id: 5 },
        ]);

        await service.update(pm, 5, { ...pmInput, accountStatus: 'INACTIVE' });

        expect(raw(prisma.$queryRaw).sql).toMatch(
          /bp_code_id IN \(SELECT bp_code_id FROM bp_codes WHERE is_platform\)/,
        );
      });

      it('상태 · 권한을 그대로 두면 잠그지도 세지도 않는다', async () => {
        await service.update(pm, 5, pmInput);

        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      });
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      prisma.adminAccount.findFirst.mockResolvedValue(target());
    });

    it('논리 삭제하고 이력을 남긴다', async () => {
      await service.remove(pm, 5);

      // 읽은 뒤 지워지거나 권한 유형 · 상태가 바뀌었으면 고치지 않는다 — 미사용으로 읽어 마지막 PM 확인을
      // 건너뛴 PM 이 그 사이 사용으로 바뀌었으면, 그대로 지우면 사용 중 PM 이 0명이 될 수 있다
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 5,
          isDeleted: false,
          roleTypeCode: 'PA',
          accountStatusCode: 'ACTIVE',
        },
        data: { isDeleted: true, updatedBy: 1 },
      });
      expect(histories()).toEqual([
        {
          adminAccountId: 5,
          field: '계정',
          beforeValue: '사용',
          afterValue: '삭제',
          changedBy: 1,
        },
      ]);
    });

    it('본인 계정은 스스로 지울 수 없다(403)', async () => {
      await expect(
        service.remove({ ...pa, adminAccountId: 5 }, 5),
      ).rejects.toThrow(
        new ForbiddenException('본인 계정은 스스로 삭제할 수 없습니다'),
      );
    });

    it('플랫폼 마스터 계정은 플랫폼 마스터만 지운다(403)', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        target({ roleTypeCode: 'PM', roleGroup: pmGroup }),
      );

      await expect(service.remove(pa, 5)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('마지막 사용 PM 은 지울 수 없다(409)', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        target({ roleTypeCode: 'PM', roleGroup: pmGroup }),
      );
      prisma.$queryRaw.mockResolvedValue([{ admin_account_id: 5 }]);

      await expect(service.remove(pm, 5)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('읽은 뒤 다른 요청이 먼저 지우거나 플랫폼 마스터로 올렸으면 이력 없이 409', async () => {
      prisma.adminAccount.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.remove(pa, 5)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.adminChangeHistory.createMany).not.toHaveBeenCalled();
    });

    it('없거나 이미 지운 계정이면 404', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(null);

      await expect(service.remove(pm, 5)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resetPassword', () => {
    /** 초기화 트랜잭션이 끝난 시각 · 메일 뒤 미발송을 내린 시각 */
    const txAt = new Date('2026-10-13T01:00:00.100Z');
    const resetAt = new Date('2026-10-13T01:00:00.123Z');
    beforeEach(() => {
      prisma.adminAccount.findFirst.mockResolvedValue(target());
      // 초기화 트랜잭션 끝에 읽고, 미발송 해제가 잠근 뒤 다시 읽는다(그 사이 저장이 없으면 같다)
      prisma.adminAccount.findUniqueOrThrow.mockResolvedValue({
        updatedAt: txAt,
      });
      prisma.adminAccount.update.mockResolvedValue({ updatedAt: resetAt });
    });

    // 초기화가 updatedAt 을 올린다. 화면이 들고 있던 값으로 저장하면 거짓 409 가 나므로 새 값을 준다.
    it('앞서 낸 초기 비밀번호를 무효로 하고, 기존 비밀번호를 막고, 1시간짜리 초기화 비밀번호를 메일로 보낸 뒤 새 최종수정일시를 준다', async () => {
      await expect(service.resetPassword(pm, 5)).resolves.toEqual({
        isMailSent: true,
        updatedAt: resetAt,
      });

      expect(prisma.temporaryPassword.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 5,
          usedAt: null,
          invalidatedAt: null,
          isDeleted: false,
        },
        data: { invalidatedAt: anyDate, updatedBy: 1 },
      });
      expect(
        firstArg<{ data: object }>(prisma.temporaryPassword.create).data,
      ).toMatchObject({ adminAccountId: 5, purpose: 'RESET', createdBy: 1 });
      // 읽은 뒤 이메일이 바뀌었으면 옛 주소로 보내지 않는다
      expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 5,
          isDeleted: false,
          roleTypeCode: 'PA',
          email: 'seojun@whale.test',
        },
        data: {
          passwordHash: '!',
          isPasswordChangeRequired: true,
          isInitialPasswordUnsent: true,
          updatedBy: 1,
        },
      });
      expect(firstArg<object>(mail.send)).toMatchObject({
        templateCode: 'EMAIL_PASSWORD_RESET',
        to: 'seojun@whale.test',
        variables: {
          관리자이름: '이서준',
          임시비밀번호: matching(/^[A-Za-z0-9]{12}$/),
          링크: 'https://admin.whale.test',
        },
        maskedVariables: ['임시비밀번호'],
        adminAccountId: 5,
        sentBy: 1,
      });
      await expect(
        verifyPassword(
          firstArg<{ variables: Record<string, string> }>(mail.send).variables
            .임시비밀번호,
          firstArg<{ data: { passwordHash: string } }>(
            prisma.temporaryPassword.create,
          ).data.passwordHash,
        ),
      ).resolves.toBe(true);
      // 미발송 해제와 updatedAt 읽기는 한 문장이다 — 따로 다시 읽으면 그 사이 다른 관리자의 저장 시각을 받아 온다
      expect(raw(prisma.$queryRaw).sql).toMatch(/FOR NO KEY UPDATE/);
      expect(prisma.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 5 },
        data: { isInitialPasswordUnsent: false },
        select: { updatedAt: true },
      });
      // 감사 이력은 초기화와 같은 트랜잭션에 쓴다 — 커밋 뒤 실패로 사라지지 않는다
      expect(histories()).toEqual([
        {
          adminAccountId: 5,
          field: '초기 비밀번호',
          beforeValue: null,
          afterValue: '초기화',
          changedBy: 1,
        },
      ]);
    });

    it('메일이 실패하면 트랜잭션이 써 둔 「미발송」이 그대로 남고, 그때의 최종수정일시를 준다', async () => {
      mail.send.mockRejectedValue(new Error('smtp down'));

      await expect(service.resetPassword(pm, 5)).resolves.toEqual({
        isMailSent: false,
        updatedAt: txAt,
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(histories()).toEqual([
        expect.objectContaining({ afterValue: '초기화' }),
      ]);
    });

    it('읽은 뒤 다른 요청이 먼저 지우거나 플랫폼 마스터로 올렸으면 비밀번호를 내지도 보내지도 않고 409', async () => {
      prisma.adminAccount.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.resetPassword(pa, 5)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.temporaryPassword.create).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });

    // 비밀번호는 이미 바뀌고 메일도 나갔다. 500 을 주면 화면이 다시 초기화하게 만든다.
    it('메일이 간 뒤 미발송 해제가 실패해도 결과를 돌려준다 — 쓰이지 않았으므로 트랜잭션 때의 최종수정일시', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      prisma.$queryRaw.mockRejectedValue(new Error('db down'));

      await expect(service.resetPassword(pm, 5)).resolves.toEqual({
        isMailSent: true,
        updatedAt: txAt,
      });
      error.mockRestore();
    });

    // 동시 초기화 · 이메일 변경: 이 비밀번호가 무효가 됐다. 뒤 메일이 실패했을 수 있으니 「미발송」을 끄지 않는다.
    it('메일이 갔어도 그 사이 비밀번호가 무효가 됐으면 미발송을 끄지 않고 트랜잭션 때의 최종수정일시를 준다', async () => {
      prisma.temporaryPassword.findFirst.mockResolvedValue(null);

      await expect(service.resetPassword(pm, 5)).resolves.toEqual({
        isMailSent: true,
        updatedAt: txAt,
      });
      expect(prisma.adminAccount.update).not.toHaveBeenCalled();
    });

    // 메일이 나가는 사이 다른 관리자가 저장했다. 새 시각을 주면 화면이 그 수정 전 값으로 409 없이 덮어쓴다.
    it('그 사이 다른 관리자가 저장했으면 미발송은 내리되 트랜잭션 때의 최종수정일시를 준다 — 다음 저장은 409', async () => {
      prisma.adminAccount.findUniqueOrThrow
        .mockResolvedValueOnce({ updatedAt: txAt })
        .mockResolvedValueOnce({
          updatedAt: new Date('2026-10-13T01:00:00.110Z'),
        });

      await expect(service.resetPassword(pm, 5)).resolves.toEqual({
        isMailSent: true,
        updatedAt: txAt,
      });
      expect(prisma.adminAccount.update).toHaveBeenCalled();
    });

    it('본인 계정은 여기서 초기화하지 않는다(403)', async () => {
      await expect(
        service.resetPassword({ ...pa, adminAccountId: 5 }, 5),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('플랫폼 마스터 계정은 플랫폼 마스터만 초기화한다(403)', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(
        target({ roleTypeCode: 'PM', roleGroup: pmGroup }),
      );

      await expect(service.resetPassword(pa, 5)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('이메일이 없는 계정은 보낼 곳이 없어 409', async () => {
      prisma.adminAccount.findFirst.mockResolvedValue(target({ email: null }));

      await expect(service.resetPassword(pm, 5)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.temporaryPassword.create).not.toHaveBeenCalled();
    });
  });
});
