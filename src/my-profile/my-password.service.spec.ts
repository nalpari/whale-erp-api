import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import {
  CURRENT_PASSWORD_MISMATCH_MESSAGE,
  MyPasswordService,
} from './my-password.service';

const CURRENT = 'OldPass123!';
const NEXT = 'NewPass456!';

describe('MyPasswordService', () => {
  let storedHash: string;
  let tx: {
    $queryRaw: jest.Mock;
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    passwordResetPin: { updateMany: jest.Mock };
    passwordResetLink: { updateMany: jest.Mock };
    emailChangePin: { updateMany: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };
  let prisma: { account: { findUnique: jest.Mock }; $transaction: jest.Mock };
  let sessions: { revokeAll: jest.Mock };

  beforeAll(async () => {
    storedHash = await hashPassword(CURRENT);
  });

  const build = async (row: Record<string, unknown> = {}) => {
    const account = {
      email: 'hong@example.com',
      passwordHash: storedHash,
      status: 'JOINED',
      ...row,
    };
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(account),
        update: jest.fn().mockResolvedValue({}),
      },
      passwordResetPin: { updateMany: jest.fn().mockResolvedValue({}) },
      passwordResetLink: { updateMany: jest.fn().mockResolvedValue({}) },
      emailChangePin: { updateMany: jest.fn().mockResolvedValue({}) },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      account: { findUnique: jest.fn().mockResolvedValue(account) },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    sessions = { revokeAll: jest.fn().mockResolvedValue(1) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MyPasswordService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthSessionService, useValue: sessions },
      ],
    }).compile();
    return moduleRef.get(MyPasswordService);
  };

  const user = { id: 12, sid: 31 };

  it('지금 비밀번호가 맞고 규칙에 맞으면 새 해시로 바꾸고, 이 기기만 남긴 채 다른 접속을 끊고, 값 없는 본인 이력을 남긴다', async () => {
    const service = await build();
    await service.change(user, CURRENT, NEXT);

    const { data } = (
      tx.account.update.mock.calls[0] as [{ data: { passwordHash: string } }]
    )[0];
    expect(data.passwordHash).toMatch(/^scrypt\$/);
    expect(data.passwordHash).not.toContain(NEXT);
    expect(sessions.revokeAll).toHaveBeenCalledWith(12, tx, 31);
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: { accountId: 12, field: 'PASSWORD', channel: 'SELF' },
    });
  });

  it('지금 비밀번호가 틀리면 400 이고 아무것도 바꾸지 않는다', async () => {
    const service = await build();
    await expect(service.change(user, 'Wrong123!', NEXT)).rejects.toThrow(
      new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('새 비밀번호가 규칙에 어긋나면 400 과 그 사유를 주고 바꾸지 않는다', async () => {
    const service = await build();
    await expect(service.change(user, CURRENT, 'short1!')).rejects.toThrow(
      new BadRequestException('3가지 이상 섞어도 8자 이상이어야 합니다.'),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('이메일 앞부분을 새 비밀번호로 쓰면 400 이다 — 규칙은 가입 · 재설정과 같은 함수다', async () => {
    const service = await build({ email: 'hongGildong12@example.com' });
    await expect(
      service.change(user, CURRENT, 'hongGildong12'),
    ).rejects.toThrow(BadRequestException);
  });

  it('탈퇴 계정은 401 이다', async () => {
    const service = await build({ status: 'WITHDRAWN' });
    await expect(service.change(user, CURRENT, NEXT)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('검증한 뒤 잠금을 잡기 전에 비밀번호가 바뀌었으면(재설정이 먼저 끝남) 400 이고 덮어쓰지 않는다', async () => {
    const service = await build();
    tx.account.findUniqueOrThrow.mockResolvedValue({
      email: 'hong@example.com',
      passwordHash: await hashPassword('Someone9!x'),
      status: 'JOINED',
    });
    await expect(service.change(user, CURRENT, NEXT)).rejects.toThrow(
      new BadRequestException(CURRENT_PASSWORD_MISMATCH_MESSAGE),
    );
    expect(tx.account.update).not.toHaveBeenCalled();
  });
});
