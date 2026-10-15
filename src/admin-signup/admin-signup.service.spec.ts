import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { hashPassword } from '../auth/password';
import { ConfigService } from '@nestjs/config';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import { AdminSignupService, type SignupInput } from './admin-signup.service';
import { BusinessVerificationService } from './business-verification.service';

// 진짜 scrypt 는 느리고, 여기서 보려는 것은 규칙이다.
jest.mock('../auth/password', () => ({ hashPassword: jest.fn() }));
const hashPasswordMock = hashPassword as jest.Mock;

// 메일은 응답을 기다리게 하지 않고 뒤에서 보낸다. 그 발송이 끝날 때까지 돌린다.
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const duplicateKey = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('AdminSignupService', () => {
  const now = new Date('2026-10-12T03:00:00.000Z');

  let service: AdminSignupService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock; findMany: jest.Mock };
    termsVersion: { findFirst: jest.Mock };
    roleGroup: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    $executeRaw: jest.Mock;
    bpCode: { findFirst: jest.Mock; create: jest.Mock };
    adminAccount: { create: jest.Mock };
    termsAgreementLog: { createMany: jest.Mock };
  };
  let mail: { send: jest.Mock };
  let jwt: { signAsync: jest.Mock };
  let verifications: {
    readToken: jest.Mock;
    isBizRegistrationNumberTaken: jest.Mock;
  };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  const input = (overrides: Partial<SignupInput> = {}): SignupInput => ({
    loginId: 'hangang01',
    password: 'whale-2026!',
    name: '정하윤',
    phone: '01048217730',
    email: 'hayoon@hangang.co.kr',
    tradeName: '㈜한강상회',
    agreeTermsOfUse: true,
    agreePrivacy: true,
    ...overrides,
  });

  beforeEach(async () => {
    jest
      .useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      })
      .setSystemTime(now);
    hashPasswordMock
      .mockReset()
      .mockImplementation((plain: string) => Promise.resolve(`hash:${plain}`));

    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      bpCode: {
        findFirst: jest.fn().mockResolvedValue({ bpCode: 'BP000003' }),
        create: jest.fn().mockResolvedValue({ bpCodeId: 40 }),
      },
      adminAccount: {
        create: jest.fn().mockResolvedValue({ adminAccountId: 70 }),
      },
      termsAgreementLog: { createMany: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { adminAccountId: 1, email: 'master@whale.example' },
          ]),
      },
      termsVersion: {
        findFirst: jest.fn(({ where }: { where: { termsTypeCode: string } }) =>
          Promise.resolve(
            where.termsTypeCode === 'TERMS_SERVICE'
              ? { termsVersionId: 11 }
              : { termsVersionId: 12 },
          ),
        ),
      },
      roleGroup: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 3 }),
      },
      $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    };
    mail = { send: jest.fn().mockResolvedValue({ messageId: 'm' }) };
    jwt = { signAsync: jest.fn().mockResolvedValue('signup-token') };
    verifications = {
      readToken: jest.fn().mockResolvedValue({
        bizRegistrationNumber: '1234567890',
        bizCeoName: '정하윤',
        bizOpenDate: '2020-03-02',
      }),
      isBizRegistrationNumberTaken: jest.fn().mockResolvedValue(false),
    };

    service = await build();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  // 메일 설정(MAIL_* · ADMIN_WEB_URL)은 선택이다 — 없으면 null · undefined 로 넣어 본다.
  // 기본값 구조 분해는 넘긴 undefined 도 기본값으로 바꾸므로, 키가 있는지로 가른다.
  const build = async (
    options: {
      mailService?: typeof mail | null;
      adminWebUrl?: string | undefined;
    } = {},
  ) => {
    const mailService = 'mailService' in options ? options.mailService : mail;
    const adminWebUrl =
      'adminWebUrl' in options
        ? options.adminWebUrl
        : 'https://admin.whale.example';
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AdminSignupService,
        { provide: PrismaService, useValue: prisma },
        { provide: OPTIONAL_MAIL_SERVICE, useValue: mailService },
        { provide: JwtService, useValue: jwt },
        { provide: BusinessVerificationService, useValue: verifications },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'ADMIN_WEB_URL' ? adminWebUrl : undefined,
          },
        },
      ],
    }).compile();
    return moduleRef.get(AdminSignupService);
  };

  afterEach(() => jest.useRealTimers());

  describe('중복 확인', () => {
    it('아이디는 탈퇴·삭제한 계정까지 포함해 본다', async () => {
      prisma.adminAccount.findFirst.mockResolvedValueOnce({
        adminAccountId: 9,
      });
      await expect(service.isLoginIdAvailable('hangang01')).resolves.toBe(
        false,
      );
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { loginId: { equals: 'hangang01', mode: 'insensitive' } },
        }),
      );
    });

    it('이메일은 삭제·탈퇴하지 않은 계정끼리만 본다', async () => {
      await expect(
        service.isEmailAvailable('hayoon@hangang.co.kr'),
      ).resolves.toBe(true);
      expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email: 'hayoon@hangang.co.kr',
            isDeleted: false,
            accountStatusCode: { not: 'WITHDRAWN' },
          },
        }),
      );
    });
  });

  describe('가입', () => {
    it('BP 와 BP 마스터 계정을 함께 만들고 약관 동의 두 건을 남긴다', async () => {
      await service.signup(input(), '203.0.113.7');

      expect(tx.bpCode.create).toHaveBeenCalledWith({
        data: {
          bpCode: 'BP000004',
          isPlatform: false,
          accountStatusCode: 'ACTIVE',
          tradeName: '㈜한강상회',
        },
        select: { bpCodeId: true },
      });
      expect(tx.adminAccount.create).toHaveBeenCalledWith({
        data: {
          loginId: 'hangang01',
          bpCodeId: 40,
          name: '정하윤',
          passwordHash: 'hash:whale-2026!',
          phone: '01048217730',
          email: 'hayoon@hangang.co.kr',
          roleTypeCode: 'BM',
          roleGroupId: 3,
          termsOfUseVersionId: 11,
          termsOfUseAgreedAt: now,
          privacyVersionId: 12,
          privacyAgreedAt: now,
          termsAgreedAt: now,
          joinPathCode: 'SIGNUP',
          isAllStores: true,
          accountStatusCode: 'ACTIVE',
        },
        select: { adminAccountId: true },
      });
      expect(tx.termsAgreementLog.createMany).toHaveBeenCalledWith({
        data: [11, 12].map((termsVersionId) => ({
          adminAccountId: 70,
          termsVersionId,
          isAgreed: true,
          agreedAt: now,
          channel: 'SIGNUP',
          clientAddress: '203.0.113.7',
        })),
      });
    });

    it('BP 마스터 권한 그룹은 BM000001 이다', async () => {
      await service.signup(input());
      expect(prisma.roleGroup.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { roleCode: 'BM000001', isDeleted: false },
        }),
      );
    });

    it('약관은 지금 사용 중인 BP 회원가입용 두 가지의 버전에 동의한 것으로 남긴다', async () => {
      await service.signup(input());
      for (const termsTypeCode of ['TERMS_SERVICE', 'PRIVACY_COLLECT'])
        expect(prisma.termsVersion.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              termsTypeCode,
              isActive: true,
              isDeleted: false,
              effectiveDate: { lte: kstToday(now) },
            },
            // 사용 중인 버전이 여럿이면 가장 늦게 시행한 것 — 정렬이 빠지면 예전 약관에 동의한 것으로 남는다.
            orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
          }),
        );
      // 동의 기록 두 줄이 그 두 버전을 하나씩 가리킨다.
      expect(tx.termsAgreementLog.createMany).toHaveBeenCalledWith({
        data: [11, 12].map((termsVersionId): unknown =>
          expect.objectContaining({ termsVersionId, adminAccountId: 70 }),
        ),
      });
    });

    it('UTC 로는 전날 0시~9시(KST) 사이에도 한국 날짜로 비교한다 — UTC 날짜를 그대로 쓰면 당일 시행 버전을 놓친다', async () => {
      // 2026-10-12 03:00 KST = 2026-10-11 18:00 UTC. new Date() 를 그대로 쓰면 UTC 날짜가
      // 아직 10-11 이라, 10-12 에 시행하는 약관 버전을 그날 가입자에게 적용하지 못한다.
      jest.setSystemTime(new Date('2026-10-11T18:00:00.000Z'));
      await service.signup(input());
      for (const termsTypeCode of ['TERMS_SERVICE', 'PRIVACY_COLLECT'])
        expect(prisma.termsVersion.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              termsTypeCode,
              isActive: true,
              isDeleted: false,
              effectiveDate: { lte: new Date('2026-10-12T00:00:00.000Z') },
            },
          }),
        );
    });

    it('BP 코드는 잠금을 잡은 뒤 가장 큰 코드의 다음 번호로 채번한다', async () => {
      const order: string[] = [];
      tx.$executeRaw.mockImplementation(() => {
        order.push('lock');
        return Promise.resolve(1);
      });
      tx.bpCode.findFirst.mockImplementation(() => {
        order.push('max');
        return Promise.resolve({ bpCode: 'BP000003' });
      });
      await service.signup(input());
      expect(order).toEqual(['lock', 'max']);
      // 삭제·탈퇴한 BP 의 코드도 다시 쓰지 않으므로 거르지 않는다.
      expect(tx.bpCode.findFirst).toHaveBeenCalledWith({
        orderBy: { bpCode: 'desc' },
        select: { bpCode: true },
      });
    });

    it('플랫폼 BP 만 있으면 첫 고객 BP 는 BP000001 이다', async () => {
      tx.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP000000' });
      await service.signup(input());
      expect(tx.bpCode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ bpCode: 'BP000001' }) as unknown,
        }),
      );
    });

    it('BP999999 다음은 채번하지 않는다', async () => {
      tx.bpCode.findFirst.mockResolvedValue({ bpCode: 'BP999999' });
      await expect(service.signup(input())).rejects.toThrow(
        'BP 코드를 더 채번할 수 없습니다',
      );
      expect(tx.bpCode.create).not.toHaveBeenCalled();
    });

    it('비밀번호 규칙에 맞지 않으면 아무것도 만들지 않고 400 이다', async () => {
      await expect(
        service.signup(input({ password: 'whale2026' })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('필수 약관에 동의하지 않으면 400 이다', async () => {
      await expect(
        service.signup(input({ agreePrivacy: false })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('쓰고 있는 아이디면 409 이다', async () => {
      prisma.adminAccount.findFirst.mockImplementation(
        ({ where }: { where: { loginId?: string } }) =>
          Promise.resolve(where.loginId ? { adminAccountId: 9 } : null),
      );
      await expect(service.signup(input())).rejects.toThrow(
        new ConflictException('사용할 수 없는 아이디입니다.'),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('쓰고 있는 이메일이면 409 이다', async () => {
      prisma.adminAccount.findFirst.mockImplementation(
        ({ where }: { where: { email?: string } }) =>
          Promise.resolve(where.email ? { adminAccountId: 9 } : null),
      );
      await expect(service.signup(input())).rejects.toThrow(
        new ConflictException('이미 등록된 이메일입니다.'),
      );
    });

    it('확인과 저장 사이에 같은 아이디가 먼저 들어가면 고유 위반을 409 로 바꾼다', async () => {
      prisma.$transaction.mockRejectedValueOnce(duplicateKey());
      // 처음 확인에서는 비어 있었고, 위반 뒤 다시 보니 있다.
      prisma.adminAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockImplementation(({ where }: { where: { loginId?: string } }) =>
          Promise.resolve(where.loginId ? { adminAccountId: 9 } : null),
        );
      await expect(service.signup(input())).rejects.toThrow(
        new ConflictException('사용할 수 없는 아이디입니다.'),
      );
    });

    it('서비스를 직접 불러도 아이디 · 이메일을 소문자로, 공백 없이 저장한다 — DTO 변환에만 기대지 않는다', async () => {
      const result = await service.signup(
        input({
          loginId: ' HanGang01 ',
          email: ' HaYoon@Hangang.co.kr ',
          tradeName: ' ㈜한강상회 ',
        }),
      );
      expect(tx.adminAccount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            loginId: 'hangang01',
            email: 'hayoon@hangang.co.kr',
          }) as unknown,
        }),
      );
      expect(tx.bpCode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tradeName: '㈜한강상회' }) as unknown,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          loginId: 'hangang01',
          email: 'hayoon@hangang.co.kr',
          tradeName: '㈜한강상회',
        }),
      );
    });

    it('확인과 저장 사이에 같은 이메일이 먼저 들어가면 이메일 409 로 바꾼다', async () => {
      prisma.$transaction.mockRejectedValueOnce(duplicateKey());
      prisma.adminAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockImplementation(({ where }: { where: { email?: string } }) =>
          Promise.resolve(where.email ? { adminAccountId: 9 } : null),
        );
      await expect(service.signup(input())).rejects.toThrow(
        new ConflictException('이미 등록된 이메일입니다.'),
      );
    });

    it('고유 위반 뒤 다시 봐도 아이디 · 이메일이 비어 있으면 원래 오류를 그대로 던진다 — 다른 고유 위반을 409 로 가리지 않게', async () => {
      const original = duplicateKey();
      prisma.$transaction.mockRejectedValueOnce(original);
      await expect(service.signup(input())).rejects.toBe(original);
    });

    it('고유 위반 뒤 다시 확인하다 실패하면 원래 고유 위반을 던진다 — 재확인 오류가 원인을 덮지 않게', async () => {
      const original = duplicateKey();
      prisma.$transaction.mockRejectedValueOnce(original);
      prisma.adminAccount.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockRejectedValue(new Error('db down'));
      await expect(service.signup(input())).rejects.toBe(original);
    });

    it('사용 중인 약관 버전이 없으면 가입을 받지 않는다', async () => {
      prisma.termsVersion.findFirst.mockResolvedValue(null);
      await expect(service.signup(input())).rejects.toThrow(
        '사용 중인 약관 TERMS_SERVICE 이(가) 없습니다',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('가입 완료 화면용 10분 토큰과 화면에 보일 값을 돌려준다', async () => {
      await expect(service.signup(input())).resolves.toEqual({
        signupToken: 'signup-token',
        tradeName: '㈜한강상회',
        loginId: 'hangang01',
        email: 'hayoon@hangang.co.kr',
      });
      // typ 이 access 가 아니라 이 토큰으로는 API 를 부를 수 없다(JwtAuthGuard).
      expect(jwt.signAsync).toHaveBeenCalledWith(
        { sub: 70, typ: 'signup' },
        { expiresIn: '10m' },
      );
    });
  });

  describe('사업자정보 인증 토큰', () => {
    it('토큰이 없으면 biz_* 를 비워 둔다', async () => {
      await service.signup(input());
      const [{ data }] = tx.bpCode.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('bizRegistrationNumber');
      expect(data).not.toHaveProperty('bizVerifiedAt');
      expect(verifications.readToken).not.toHaveBeenCalled();
    });

    it('토큰이 있으면 토큰의 값과 가입 시각을 저장한다', async () => {
      await service.signup(input({ bizVerificationToken: 'biz-token' }));
      expect(verifications.readToken).toHaveBeenCalledWith('biz-token');
      expect(tx.bpCode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bizRegistrationNumber: '1234567890',
            bizCeoName: '정하윤',
            bizOpenDate: new Date('2020-03-02T00:00:00.000Z'),
            bizVerifiedAt: now,
          }) as unknown,
        }),
      );
    });

    it('토큰이 틀리면 트랜잭션 전에 400', async () => {
      verifications.readToken.mockRejectedValue(
        new BadRequestException(
          '사업자정보 인증이 만료되었습니다. 다시 인증해 주세요.',
        ),
      );
      await expect(
        service.signup(input({ bizVerificationToken: 'old' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('번호를 다시 보기 전에 점포 등록과 같은 번호 잠금을 잡는다 — 점포 저장과 동시에 같은 번호가 들어가지 않게', async () => {
      const order: string[] = [];
      tx.$executeRaw.mockImplementation(
        (_: TemplateStringsArray, ...values: unknown[]) => {
          order.push(`lock:${values.join(',')}`);
          return Promise.resolve(1);
        },
      );
      verifications.isBizRegistrationNumberTaken.mockImplementation(() => {
        order.push('recheck');
        return Promise.resolve(false);
      });
      await service.signup(input({ bizVerificationToken: 'biz-token' }));
      expect(order).toContain('lock:stores:biz:1234567890');
      expect(order.indexOf('lock:stores:biz:1234567890')).toBeLessThan(
        order.indexOf('recheck'),
      );
    });

    it('다른 경로가 같은 번호를 먼저 넣어 고유 위반이 나면 500 이 아니라 번호 409 로 바꾼다', async () => {
      prisma.$transaction.mockRejectedValueOnce(duplicateKey());
      // 트랜잭션 밖에서 다시 보니 번호가 쓰인다(아이디 · 이메일은 비어 있다).
      verifications.isBizRegistrationNumberTaken.mockResolvedValue(true);
      await expect(
        service.signup(input({ bizVerificationToken: 'biz-token' })),
      ).rejects.toThrow(
        new ConflictException('이미 등록된 사업자등록번호입니다.'),
      );
    });

    it('고유 위반 뒤 번호를 다시 보다 실패하면 원래 고유 위반을 던진다 — 재확인 오류가 원인을 덮지 않게', async () => {
      const original = duplicateKey();
      prisma.$transaction.mockRejectedValueOnce(original);
      verifications.isBizRegistrationNumberTaken.mockRejectedValue(
        new Error('db down'),
      );
      await expect(
        service.signup(input({ bizVerificationToken: 'biz-token' })),
      ).rejects.toBe(original);
    });

    it('트랜잭션 안에서 번호가 이미 쓰이면 409 이고 BP 를 만들지 않는다', async () => {
      verifications.isBizRegistrationNumberTaken.mockResolvedValue(true);
      await expect(
        service.signup(input({ bizVerificationToken: 'biz-token' })),
      ).rejects.toThrow(
        new ConflictException('이미 등록된 사업자등록번호입니다.'),
      );
      expect(verifications.isBizRegistrationNumberTaken).toHaveBeenCalledWith(
        '1234567890',
        tx,
      );
      expect(tx.bpCode.create).not.toHaveBeenCalled();
    });
  });

  describe('가입 메일', () => {
    it('가입자에게 완료 메일, 플랫폼 마스터에게 가입 알림을 보낸다', async () => {
      await service.signup(input());
      await flush();

      expect(mail.send).toHaveBeenCalledWith({
        templateCode: 'EMAIL_SIGNUP_DONE',
        to: 'hayoon@hangang.co.kr',
        variables: {
          관리자이름: '정하윤',
          BP이름: '㈜한강상회',
          로그인아이디: 'hangang01',
          링크: 'https://admin.whale.example',
        },
        adminAccountId: 70,
      });
      expect(mail.send).toHaveBeenCalledWith({
        templateCode: 'EMAIL_SIGNUP_ALERT',
        to: 'master@whale.example',
        variables: {
          BP이름: '㈜한강상회',
          링크: 'https://admin.whale.example',
        },
        adminAccountId: 1,
      });
      expect(prisma.adminAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            roleTypeCode: 'PM',
            isDeleted: false,
            accountStatusCode: 'ACTIVE',
            email: { not: null },
          },
        }),
      );
    });

    it('메일이 실패해도 가입은 완료다', async () => {
      mail.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.signup(input())).resolves.toEqual(
        expect.objectContaining({ signupToken: 'signup-token' }),
      );
      await flush();
      expect(error).toHaveBeenCalled();
    });

    it('보내기 전 단계의 실패(템플릿 없음 등)는 사유까지 남긴다 — mail_send_logs 에도 남지 않으므로', async () => {
      mail.send.mockRejectedValue(
        new Error('템플릿 EMAIL_SIGNUP_DONE 은(는) 사용하지 않는 상태입니다'),
      );
      await service.signup(input());
      await flush();
      expect(error).toHaveBeenCalledWith(
        'signup mail FAILED adminAccountId=70 error=Error code=undefined message=템플릿 EMAIL_SIGNUP_DONE 은(는) 사용하지 않는 상태입니다',
      );
    });

    it('SMTP 오류는 코드만 남기고 메시지는 남기지 않는다 — 응답에 받는 주소가 섞인다', async () => {
      mail.send.mockRejectedValue(
        Object.assign(new Error('550 <HAYOON@hangang.co.kr> rejected'), {
          code: 'EENVELOPE',
          responseCode: 550,
        }),
      );
      await service.signup(input());
      await flush();
      expect(error).toHaveBeenCalledWith(
        'signup mail FAILED adminAccountId=70 error=Error code=EENVELOPE',
      );
      for (const [line] of error.mock.calls as [string][])
        expect(line).not.toMatch(/hangang.co.kr/i);
    });

    it('받을 플랫폼 마스터가 없으면 가입 알림을 못 보낸 것을 남긴다', async () => {
      prisma.adminAccount.findMany.mockResolvedValue([]);
      await service.signup(input());
      await flush();
      expect(warn).toHaveBeenCalledWith(
        'signup alert SKIPPED no active platform master adminAccountId=70',
      );
    });

    it('플랫폼 마스터 조회가 실패해도 가입은 완료다', async () => {
      prisma.adminAccount.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.signup(input())).resolves.toBeDefined();
      await flush();
      expect(error).toHaveBeenCalled();
    });

    it('여러 마스터 중 일부만 실패해도 각자 따로 로그를 남긴다 — 한 명 탓에 나머지가 가려지지 않는다', async () => {
      prisma.adminAccount.findMany.mockResolvedValue([
        { adminAccountId: 1, email: 'master1@whale.example' },
        { adminAccountId: 2, email: 'master2@whale.example' },
      ]);
      mail.send.mockImplementation(
        ({ templateCode }: { templateCode: string }) =>
          templateCode === 'EMAIL_SIGNUP_ALERT'
            ? Promise.reject(new Error('smtp down'))
            : Promise.resolve({}),
      );
      await expect(service.signup(input())).resolves.toBeDefined();
      await flush();
      // 실패한 마스터 둘 다 각자의 id 로 남는다 — 한 명 탓에 나머지가 가려지지 않는다.
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('adminAccountId=1'),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('adminAccountId=2'),
      );
    });

    it('MAIL_* 가 없으면 메일만 건너뛰고 가입은 완료다 — 메일 설정 없이도 api 가 뜬다', async () => {
      service = await build({ mailService: null });
      await expect(service.signup(input())).resolves.toEqual(
        expect.objectContaining({ signupToken: 'signup-token' }),
      );
      await flush();
      expect(prisma.adminAccount.findMany).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'signup mail SKIPPED no MAIL_* adminAccountId=70',
        ),
      );
    });

    it('ADMIN_WEB_URL 이 없으면 메일을 보내지 않는다 — 버튼 링크가 빈 메일이 나가지 않게', async () => {
      service = await build({ adminWebUrl: undefined });
      await expect(service.signup(input())).resolves.toBeDefined();
      await flush();
      expect(mail.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'signup mail SKIPPED no ADMIN_WEB_URL adminAccountId=70',
        ),
      );
    });

    it('운영에서 메일 설정이 비면 기동 때 빈 것을 모두 알린다 — 하나 고쳐 다시 배포해야 다음 것이 드러나지 않게', async () => {
      const before = process.env.APP_ENV;
      process.env.APP_ENV = 'prod';
      try {
        await build({ mailService: null, adminWebUrl: undefined });
      } finally {
        if (before === undefined) delete process.env.APP_ENV;
        else process.env.APP_ENV = before;
      }
      expect(error).toHaveBeenCalledWith(
        'MAIL_*, ADMIN_WEB_URL 이 비어 있어 가입 메일을 보낼 수 없다',
      );
    });

    it('ADMIN_WEB_URL 이 http(s) 주소가 아니면 기동 때 던진다', async () => {
      await expect(
        build({ adminWebUrl: 'admin.whale.example' }),
      ).rejects.toThrow('ADMIN_WEB_URL 은 http(s) 주소여야 합니다');
    });

    it('저장이 실패하면 메일을 보내지 않는다', async () => {
      prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
      await expect(service.signup(input())).rejects.toThrow('db down');
      await flush();
      expect(mail.send).not.toHaveBeenCalled();
    });
  });
});
