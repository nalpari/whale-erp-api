import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import { AdminProfileService } from './admin-profile.service';

describe('AdminProfileService', () => {
  let service: AdminProfileService;
  let tx: {
    adminAccount: {
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    adminChangeHistory: { createMany: jest.Mock };
    temporaryPassword: { updateMany: jest.Mock };
  };
  let prismaAdminAccountFindFirst: jest.Mock;

  const UPDATED_AT = '2026-10-21T00:00:00.000Z';

  const account = (over: Record<string, unknown> = {}) => ({
    adminAccountId: 7,
    loginId: 'whale01',
    name: '이서준',
    phone: '01012345678',
    email: 'seojun@whale.test',
    roleTypeCode: 'BM',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date(UPDATED_AT),
    isDeleted: false,
    ...over,
  });

  beforeEach(async () => {
    tx = {
      adminAccount: {
        // find() 가 쓰는 첫 호출은 계정, update() 안에서 이메일이 바뀌었을 때만 도는 findEmailOwner()
        // 는 기본으로 충돌 없음(null) — 충돌을 보는 테스트는 두 번째 호출을 따로 덮어쓴다.
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(account())
          .mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminChangeHistory: { createMany: jest.fn() },
      temporaryPassword: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prismaAdminAccountFindFirst = jest.fn().mockResolvedValue(account());
    const prisma = {
      adminAccount: { findFirst: prismaAdminAccountFindFirst },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    service = (
      await Test.createTestingModule({
        providers: [
          AdminProfileService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile()
    ).get(AdminProfileService);
  });

  describe('get', () => {
    it('계정을 내 정보 모양으로 돌려준다', async () => {
      await expect(service.get(7)).resolves.toEqual({
        loginId: 'whale01',
        name: '이서준',
        phone: '01012345678',
        email: 'seojun@whale.test',
        roleTypeCode: 'BM',
        createdAt: account().createdAt,
        lastLoginAt: account().lastLoginAt,
        updatedAt: account().updatedAt,
      });
    });

    it('이름 · 연락처 · 이메일이 비어 있으면 빈 문자열로 준다', async () => {
      prismaAdminAccountFindFirst.mockResolvedValue(
        account({ name: null, phone: null, email: null }),
      );
      const result = await service.get(7);
      expect(result).toMatchObject({ name: '', phone: '', email: '' });
    });

    it('지운 계정 · 없는 계정은 404', async () => {
      prismaAdminAccountFindFirst.mockResolvedValue(null);
      await expect(service.get(7)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    // 이메일을 바꾸는 입력 — 지금 비밀번호 없이 보낸다(이메일을 바꿔도 보지 않는다, 2026-10-23 사용자 결정).
    const input = {
      name: '김하늘',
      phone: '01099998888',
      email: 'haneul@whale.test',
      updatedAt: UPDATED_AT,
    };

    it('바뀐 값만 저장하고 변경 이력에 남긴다 — 동시 수정 검사는 조회 때 받은 updatedAt 으로', async () => {
      await service.update(7, input);
      expect(tx.adminAccount.updateMany).toHaveBeenCalledWith({
        where: { adminAccountId: 7, updatedAt: sameMillisecond(UPDATED_AT) },
        data: {
          name: input.name,
          phone: input.phone,
          email: input.email,
          updatedBy: 7,
        },
      });
      const [[{ data }]] = tx.adminChangeHistory.createMany.mock.calls as [
        [{ data: unknown[] }],
      ];
      expect(data).toEqual([
        {
          adminAccountId: 7,
          field: '이름',
          beforeValue: '이서준',
          afterValue: '김하늘',
          changedBy: 7,
        },
        {
          adminAccountId: 7,
          field: '연락처',
          beforeValue: '01012345678',
          afterValue: '01099998888',
          changedBy: 7,
        },
        {
          adminAccountId: 7,
          field: '이메일',
          beforeValue: 'seojun@whale.test',
          afterValue: 'haneul@whale.test',
          changedBy: 7,
        },
      ]);
    });

    it('이메일을 안 바꾸면 지금 비밀번호 없이도 저장된다', async () => {
      await service.update(7, {
        name: '이서준',
        phone: '01099998888',
        email: 'seojun@whale.test',
        updatedAt: UPDATED_AT,
      });
      expect(tx.adminAccount.updateMany).toHaveBeenCalled();
    });

    it('아무것도 안 바뀌면 이력을 남기지 않는다', async () => {
      await service.update(7, {
        name: '이서준',
        phone: '01012345678',
        email: 'seojun@whale.test',
        updatedAt: UPDATED_AT,
      });
      expect(tx.adminChangeHistory.createMany).not.toHaveBeenCalled();
    });

    it('이메일을 바꿀 때 지금 비밀번호가 없어도 저장된다(S-JXKHCM)', async () => {
      await service.update(7, input);
      expect(tx.adminAccount.updateMany).toHaveBeenCalled();
    });

    it('이메일을 원래 값 그대로 두면 중복 확인을 하지 않는다', async () => {
      await service.update(7, { ...input, email: 'seojun@whale.test' });
      expect(tx.adminAccount.findFirst).toHaveBeenCalledTimes(1); // find() 한 번뿐, findEmailOwner 는 안 돈다
    });

    it('이메일을 바꾸면 쓰지 않은 임시 비밀번호를 무효로 한다', async () => {
      tx.temporaryPassword.updateMany.mockResolvedValue({ count: 2 });
      await service.update(7, input);
      expect(tx.temporaryPassword.updateMany).toHaveBeenCalledWith({
        where: {
          adminAccountId: 7,
          usedAt: null,
          invalidatedAt: null,
          isDeleted: false,
        },
        data: { invalidatedAt: expect.any(Date) as Date, updatedBy: 7 },
      });
      // 무효로 한 게 있으면 「미발송」을 다시 켠다 — 등록·초기화 계정의 유일한 로그인 수단을 되살린다.
      expect(tx.adminAccount.update).toHaveBeenCalledWith({
        where: { adminAccountId: 7 },
        data: { isInitialPasswordUnsent: true },
      });
    });

    it('이메일을 안 바꾸면 임시 비밀번호를 건드리지 않는다', async () => {
      await service.update(7, { ...input, email: 'seojun@whale.test' });
      expect(tx.temporaryPassword.updateMany).not.toHaveBeenCalled();
      expect(tx.adminAccount.update).not.toHaveBeenCalled();
    });

    it('그사이 다른 관리자가 고쳤으면(동시 수정) 409 — 저장하지 않는다', async () => {
      tx.adminAccount.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(7, input)).rejects.toThrow(ConflictException);
      expect(tx.adminChangeHistory.createMany).not.toHaveBeenCalled();
      expect(tx.temporaryPassword.updateMany).not.toHaveBeenCalled();
    });

    it('다른(탈퇴하지 않은) 계정이 그 이메일을 쓰면 409', async () => {
      tx.adminAccount.findFirst
        .mockReset()
        .mockResolvedValueOnce(account()) // find()
        .mockResolvedValueOnce({ adminAccountId: 99 }); // findEmailOwner()
      await expect(service.update(7, input)).rejects.toThrow(ConflictException);
      expect(tx.adminAccount.updateMany).not.toHaveBeenCalled();
    });

    it('DB 유니크 제약을 직접 걸면(경합) 409로 바꾼다', async () => {
      tx.adminAccount.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '0',
        }),
      );
      await expect(service.update(7, input)).rejects.toThrow(ConflictException);
    });

    it('지운 계정이면 404', async () => {
      tx.adminAccount.findFirst.mockReset().mockResolvedValue(null);
      await expect(service.update(7, input)).rejects.toThrow(NotFoundException);
    });
  });

  describe('checkEmailAvailable', () => {
    it('아무도 안 쓰면 true', async () => {
      prismaAdminAccountFindFirst.mockResolvedValue(null);
      await expect(
        service.checkEmailAvailable(7, 'new@whale.test'),
      ).resolves.toBe(true);
    });

    it('다른 탈퇴하지 않은 계정이 쓰면 false, 본인은 빼고 본다', async () => {
      prismaAdminAccountFindFirst.mockResolvedValue({ adminAccountId: 99 });
      await expect(
        service.checkEmailAvailable(7, 'taken@whale.test'),
      ).resolves.toBe(false);
      expect(prismaAdminAccountFindFirst).toHaveBeenCalledWith({
        where: {
          email: 'taken@whale.test',
          isDeleted: false,
          accountStatusCode: { not: 'WITHDRAWN' },
          adminAccountId: { not: 7 },
        },
        select: { adminAccountId: true },
      });
    });
  });
});
