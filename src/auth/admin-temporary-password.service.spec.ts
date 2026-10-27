import {
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as mailService from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_MAIL,
  AdminTemporaryPasswordService,
  generateTemporaryPassword,
  TEMPORARY_PASSWORD_SENT_MESSAGE,
  TEMPORARY_PASSWORD_SEND_FAILED,
} from './admin-temporary-password.service';
import { LOGIN_ID_NOT_FOUND_MESSAGE } from './admin-login-id-find.service';
import { AdminTemporaryPasswordDto } from './dto/admin-temporary-password.dto';

describe('AdminTemporaryPasswordDto', () => {
  // 같은 계정 찾기 화면의 아이디 찾기(AdminLoginIdFindDto)와 같은 규칙이다 — 다르면 한쪽만 맞는다.
  it('이름은 앞뒤 공백을 지우고, 한글 자모가 풀려 와도(NFD) 같은 이름으로 본다', async () => {
    const dto = plainToInstance(AdminTemporaryPasswordDto, {
      name: ` ${'홍길동'.normalize('NFD')} `,
      loginId: 'whale01',
      email: 'a@test.invalid',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.name).toBe('홍길동');
  });

  it('공백뿐인 이름은 거른다', async () => {
    const dto = plainToInstance(AdminTemporaryPasswordDto, {
      name: '   ',
      loginId: 'whale01',
      email: 'a@test.invalid',
    });
    expect((await validate(dto)).map((e) => e.property)).toEqual(['name']);
  });
});

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

const EDITED_AT = new Date('2026-10-01T00:00:00Z');

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
    adminAccount: { findFirst: jest.Mock; update: jest.Mock };
  };
  let mail: { send: jest.Mock };
  const dto = { name: '홍길동', loginId: 'whale01', email: 'a@test.invalid' };
  const SENT = { message: TEMPORARY_PASSWORD_SENT_MESSAGE };
  const matching = {
    loginId: 'whale01',
    name: '홍길동',
    email: 'a@test.invalid',
    accountStatusCode: 'ACTIVE',
    isDeleted: false,
  };

  beforeEach(async () => {
    tx = {
      $queryRaw: jest.fn(),
      temporaryPassword: { updateMany: jest.fn(), create: jest.fn() },
      adminAccount: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ adminAccountId: 7, updatedAt: EDITED_AT }),
        update: jest.fn(),
      },
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

  afterEach(() => jest.restoreAllMocks());

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

  it('맞는 계정이면 메일을 보내고, 앞의 찾기용 임시 비밀번호를 끝내고, 잠금을 푼다 — 강제 변경 표시는 건드리지 않는다(로그인 중인 세션이 막히지 않게)', async () => {
    await expect(service.issue(dto)).resolves.toEqual(SENT);
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
    // 만료 전까지 다시 쓸 수 있으므로 이미 쓴 것도 끝낸다. 플랫폼 관리자가 준 초기 · 초기화 비밀번호는 둔다 —
    // 그것으로 강제 변경 중인 세션이 이 공개 경로 때문에 401 이 되지 않게.
    expect(tx.temporaryPassword.updateMany).toHaveBeenCalledWith({
      where: {
        adminAccountId: 7,
        purpose: 'TEMPORARY',
        invalidatedAt: null,
      },
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
        // 잠금 해제는 계정 수정이 아니다 — 수정 일시를 그대로 둔다.
        updatedAt: EDITED_AT,
      },
    });
  });

  it('메일을 보내는 사이 계정이 바뀌었으면(이메일 · 상태 · 삭제) 저장하지 않는다 — 옛 주소로 간 비밀번호가 살아나지 않게', async () => {
    tx.adminAccount.findFirst.mockResolvedValue(null);
    await expect(service.issue(dto)).resolves.toEqual(SENT);
    // 잠금을 잡은 뒤 처음과 같은 조건으로 다시 읽는다.
    expect(tx.adminAccount.findFirst).toHaveBeenCalledWith({
      where: { adminAccountId: 7, ...matching },
      select: { adminAccountId: true, updatedAt: true },
    });
    expect(tx.temporaryPassword.create).not.toHaveBeenCalled();
    expect(tx.temporaryPassword.updateMany).not.toHaveBeenCalled();
  });

  it('맞는 계정이 없으면(미사용 · 탈퇴 · 삭제와만 맞아도) 아이디 찾기와 같은 문구의 404 이고 메일을 보내지 않는다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    const err = await service.issue(dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe(LOGIN_ID_NOT_FOUND_MESSAGE);
    // 사용 중 · 미삭제 조건으로 찾아야 미사용 · 탈퇴 · 삭제 계정이 404 로 떨어진다.
    expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: matching }),
    );
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('1시간에 5번을 넘으면 429 — 503 과 구별되는 한글 문구', async () => {
    prisma.temporaryPassword.count.mockResolvedValue(5);
    const err = await service.issue(dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).message).toBe(
      '임시 비밀번호는 1시간에 5번까지 받을 수 있습니다',
    );
    expect(mail.send).not.toHaveBeenCalled();
  });

  const expectSendFailed = async (issuing: Promise<unknown>) => {
    const err = await issuing.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toEqual(
      expect.objectContaining({
        statusCode: 503,
        code: TEMPORARY_PASSWORD_SEND_FAILED,
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  it('SMTP 가 실패하면 저장하지 않고 503 + 코드로 알린다 — 화면이 「보내지 못했습니다」로 안내하게', async () => {
    mail.send.mockRejectedValue(new Error('smtp down'));
    jest.spyOn(mailService, 'isMailTransportError').mockReturnValue(true);
    await expectSendFailed(service.issue(dto));
  });

  it('보내기 전에 막힌 실패(템플릿 꺼짐 · DB 오류 등)는 503 이 아니라 원래 예외다 — 다시 시도해도 풀리지 않는다', async () => {
    const blocked = new Error(
      '템플릿 EMAIL_TEMP_PASSWORD 은(는) 사용하지 않는 상태입니다',
    );
    mail.send.mockRejectedValue(blocked);
    jest.spyOn(mailService, 'isMailTransportError').mockReturnValue(false);
    await expect(service.issue(dto)).rejects.toBe(blocked);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('메일 설정(MAIL_* · ADMIN_WEB_URL)이 없어도 앱은 뜨고, 발급은 저장하지 않고 같은 503 이다', async () => {
    const noMail = await build(null);
    await expectSendFailed(noMail.issue(dto));
  });
});
