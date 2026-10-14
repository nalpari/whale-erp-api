import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_MAIL,
  AdminTemporaryPasswordService,
  generateTemporaryPassword,
  TEMPORARY_PASSWORD_SENT_MESSAGE,
} from './admin-temporary-password.service';

describe('generateTemporaryPassword', () => {
  it('12자이고 영문 대문자 · 소문자 · 숫자 · 특수문자를 하나 이상 담는다(비밀번호 정책 PL-QSBSYY)', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(12);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%^&*]/);
      // 헷갈리는 글자(0·O·1·l·I)를 쓰지 않는다 — 메일을 보고 손으로 옮겨 적는다.
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });
});

describe('AdminTemporaryPasswordService', () => {
  let service: AdminTemporaryPasswordService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock };
    temporaryPassword: { count: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    $queryRaw: jest.Mock;
    temporaryPassword: { updateMany: jest.Mock; create: jest.Mock };
    adminAccount: { update: jest.Mock };
  };
  let mail: { send: jest.Mock };
  const dto = { name: '홍길동', loginId: 'whale01', email: 'a@test.invalid' };

  beforeEach(async () => {
    tx = {
      $queryRaw: jest.fn(),
      temporaryPassword: { updateMany: jest.fn(), create: jest.fn() },
      adminAccount: { update: jest.fn() },
    };
    prisma = {
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({
          adminAccountId: 7,
          name: '홍길동',
          email: 'a@test.invalid',
        }),
      },
      temporaryPassword: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    mail = { send: jest.fn().mockResolvedValue({}) };
    service = await build(mail);
  });

  const build = async (mailService: { send: jest.Mock } | null) =>
    (
      await Test.createTestingModule({
        providers: [
          AdminTemporaryPasswordService,
          { provide: PrismaService, useValue: prisma },
          // 메일 수단은 MAIL_* 와 ADMIN_WEB_URL 이 다 있을 때만 있다(createPlatformAdminMail).
          {
            provide: ADMIN_MAIL,
            useValue: mailService && {
              mail: mailService,
              webUrl: 'https://admin.whale.test',
            },
          },
        ],
      }).compile()
    ).get(AdminTemporaryPasswordService);

  it('맞는 계정이면 메일을 보내고, 남은 임시 비밀번호를 모두 끝내고, 강제 변경 · 잠금 해제를 한다', async () => {
    await expect(service.issue(dto)).resolves.toEqual({
      message: TEMPORARY_PASSWORD_SENT_MESSAGE,
    });
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        templateCode: 'EMAIL_TEMP_PASSWORD',
        to: 'a@test.invalid',
        maskedVariables: ['임시비밀번호'],
        variables: expect.objectContaining({
          링크: 'https://admin.whale.test/login',
        }) as unknown,
      }),
    );
    // 만료 전까지 다시 쓸 수 있으므로 이미 쓴 것도 끝낸다.
    expect(tx.temporaryPassword.updateMany).toHaveBeenCalledWith({
      where: { adminAccountId: 7, invalidatedAt: null },
      data: { invalidatedAt: expect.any(Date) as unknown },
    });
    expect(tx.temporaryPassword.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminAccountId: 7,
        purpose: 'TEMPORARY',
      }) as unknown,
    });
    expect(tx.adminAccount.update).toHaveBeenCalledWith({
      where: { adminAccountId: 7 },
      data: {
        failedLoginCount: 0,
        lockExpiresAt: null,
        isPasswordChangeRequired: true,
      },
    });
  });

  it('맞는 계정이 없으면 메일 없이 같은 응답', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    await expect(service.issue(dto)).resolves.toEqual({
      message: TEMPORARY_PASSWORD_SENT_MESSAGE,
    });
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('1시간에 5번을 넘으면 429', async () => {
    prisma.temporaryPassword.count.mockResolvedValue(5);
    await expect(service.issue(dto)).rejects.toBeInstanceOf(HttpException);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('메일이 실패하면 503 이고 저장하지 않는다', async () => {
    mail.send.mockRejectedValue(new Error('smtp down'));
    await expect(service.issue(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('메일 설정(MAIL_* · ADMIN_WEB_URL)이 없으면 맞는 계정에만 503 이고 저장하지 않는다 — 앱은 뜬다', async () => {
    const noMail = await build(null);
    await expect(noMail.issue(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();

    prisma.adminAccount.findFirst.mockResolvedValue(null);
    await expect(noMail.issue(dto)).resolves.toEqual({
      message: TEMPORARY_PASSWORD_SENT_MESSAGE,
    });
  });
});
