/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining 은 any 를 돌려준다 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  STORE_CLOSING_TRANSACTION_TIMEOUT_MS,
  StoreClosingsService,
} from '../store-closings/store-closings.service';
import { ADMIN_PASSWORD_MESSAGES } from './admin-password-policy';
import { AdminWithdrawalService } from './admin-withdrawal.service';
import { hashPassword } from './password';

describe('AdminWithdrawalService.getEligibility', () => {
  let service: AdminWithdrawalService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock; count: jest.Mock };
    bpCode: { findUniqueOrThrow: jest.Mock };
    store: { findMany: jest.Mock };
  };
  let closings: { check: jest.Mock };

  /** 폐점 확인 결과 — 점포별 값은 front 가 점포를 골라 보여 줄 때 그대로 쓴다 */
  const closingOf = (isBlocked: boolean) => ({
    stores: [{ storeId: 101, storeName: '강남점', storeCode: 'ST000101' }],
    total: { isBlocked },
    isBlocked,
  });

  beforeEach(async () => {
    prisma = {
      adminAccount: { findFirst: jest.fn(), count: jest.fn() },
      bpCode: { findUniqueOrThrow: jest.fn() },
      store: { findMany: jest.fn() },
    };
    closings = { check: jest.fn() };
    service = (
      await Test.createTestingModule({
        providers: [
          AdminWithdrawalService,
          { provide: PrismaService, useValue: prisma },
          { provide: StoreClosingsService, useValue: closings },
          { provide: OPTIONAL_MAIL_SERVICE, useValue: null },
        ],
      }).compile()
    ).get(AdminWithdrawalService);
  });

  it('BP 마스터가 아니면 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BA',
      bpCodeId: 1,
    });
    await expect(service.getEligibility(1)).rejects.toThrow(ForbiddenException);
  });

  it('지운 계정이면 404', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null); // isDeleted:false 필터로 이미 걸러짐
    await expect(service.getEligibility(1)).rejects.toThrow(NotFoundException);
  });

  it('이미 탈퇴한 계정이면 404', async () => {
    // 탈퇴는 isDeleted 를 바꾸지 않는다(상태만 탈퇴) — 상태로 따로 거른다. execute 와 같다.
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 7,
      accountStatusCode: 'WITHDRAWN',
    });
    await expect(service.getEligibility(1)).rejects.toThrow(NotFoundException);
    expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
      where: { adminAccountId: 1, isDeleted: false },
      select: { roleTypeCode: true, bpCodeId: true, accountStatusCode: true },
    });
    expect(closings.check).not.toHaveBeenCalled();
  });

  it('플랫폼 BP 면 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 1,
      accountStatusCode: 'ACTIVE',
    });
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일',
      accountStatusCode: 'ACTIVE',
      isPlatform: true,
    });
    await expect(service.getEligibility(1)).rejects.toThrow(
      new ForbiddenException('플랫폼 BP 는 탈퇴할 수 없습니다.'),
    );
    expect(prisma.adminAccount.count).not.toHaveBeenCalled();
    expect(closings.check).not.toHaveBeenCalled();
  });

  it('BP명 · 하위 관리자 수 · 점포 수와, 폐점 안 한 점포 전부의 폐점 확인을 돌려준다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 7,
    });
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일분식',
    });
    prisma.adminAccount.count.mockResolvedValue(6);
    prisma.store.findMany.mockResolvedValue([
      { storeId: 101 },
      { storeId: 102 },
    ]);
    closings.check.mockResolvedValue(closingOf(true));

    const result = await service.getEligibility(1);

    expect(result).toEqual({
      bpName: '웨일분식',
      adminCount: 6,
      storeCount: 2,
      closing: closingOf(true),
    });
    expect(prisma.adminAccount.count).toHaveBeenCalledWith({
      where: {
        bpCodeId: 7,
        adminAccountId: { not: 1 },
        isDeleted: false,
        accountStatusCode: { not: 'WITHDRAWN' },
      },
    });
    // 이미 폐점했거나 지운 점포는 확인 대상에 넣지 않는다
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: {
        bpCodeId: 7,
        isDeleted: false,
        storeStatusCode: { not: 'CLOSED' },
      },
      select: { storeId: true },
    });
    expect(closings.check).toHaveBeenCalledWith(prisma, [101, 102]);
  });

  it('진행 중 계약은 보지 않는다 — 막힘은 폐점 확인의 isBlocked 뿐이다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 7,
    });
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일분식',
    });
    prisma.adminAccount.count.mockResolvedValue(0);
    prisma.store.findMany.mockResolvedValue([]);
    closings.check.mockResolvedValue(closingOf(false));

    const result = await service.getEligibility(1);

    expect(result.closing.isBlocked).toBe(false);
    expect(result).not.toHaveProperty('hasInProgressContract');
    expect(closings.check).toHaveBeenCalledWith(prisma, []);
  });
});

describe('AdminWithdrawalService.execute', () => {
  const PASSWORD = 'whale-2026!';
  const dto = { currentPassword: PASSWORD, reasonCode: 'WD_CLOSE' };
  const now = new Date('2026-10-27T05:00:00Z');

  let service: AdminWithdrawalService;
  let passwordHash: string;
  let mailService: { send: jest.Mock };
  let closings: { close: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    adminAccount: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    bpCode: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    adminChangeHistory: { createMany: jest.Mock };
    bpChangeHistory: { create: jest.Mock };
    adminSession: { updateMany: jest.Mock };
  };

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  const master = (over: Record<string, unknown> = {}) => ({
    roleTypeCode: 'BM',
    bpCodeId: 7,
    passwordHash,
    email: 'master@whale.kr',
    accountStatusCode: 'ACTIVE',
    ...over,
  });

  const build = async (mail: { send: jest.Mock } | null) =>
    (
      await Test.createTestingModule({
        providers: [
          AdminWithdrawalService,
          // 바깥 클라이언트에는 $transaction 만 — 나머지는 전부 트랜잭션(tx)으로 해야 통과한다.
          {
            provide: PrismaService,
            useValue: { $transaction: prisma.$transaction },
          },
          { provide: StoreClosingsService, useValue: closings },
          { provide: OPTIONAL_MAIL_SERVICE, useValue: mail },
        ],
      }).compile()
    ).get(AdminWithdrawalService);

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(now);
    prisma = {
      $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([]),
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue(master()),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      bpCode: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          tradeName: '웨일분식',
          accountStatusCode: 'ACTIVE',
        }),
        update: jest.fn(),
      },
      adminChangeHistory: { createMany: jest.fn() },
      bpChangeHistory: { create: jest.fn() },
      adminSession: { updateMany: jest.fn() },
    };
    mailService = { send: jest.fn().mockResolvedValue(undefined) };
    closings = {
      close: jest.fn().mockResolvedValue({ stores: [], total: {} }),
    };
    service = await build(mailService);
  });

  afterEach(() => jest.useRealTimers());

  const expectNoMutation = () => {
    expect(prisma.adminAccount.update).not.toHaveBeenCalled();
    expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.bpCode.update).not.toHaveBeenCalled();
    expect(closings.close).not.toHaveBeenCalled();
    expect(prisma.adminChangeHistory.createMany).not.toHaveBeenCalled();
    expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
    expect(mailService.send).not.toHaveBeenCalled();
  };

  it('계정이 없으면 404', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null);
    await expect(service.execute(1, dto)).rejects.toThrow(NotFoundException);
    expectNoMutation();
  });

  it('이미 탈퇴한 계정이면 404', async () => {
    // 탈퇴는 isDeleted 를 바꾸지 않는다(상태만 탈퇴) — 상태로 따로 거른다.
    prisma.adminAccount.findFirst.mockResolvedValue(
      master({ accountStatusCode: 'WITHDRAWN', email: null }),
    );
    await expect(service.execute(1, dto)).rejects.toThrow(NotFoundException);
    expectNoMutation();
  });

  it('BP 마스터가 아니면 403', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(
      master({ roleTypeCode: 'BA' }),
    );
    await expect(service.execute(1, dto)).rejects.toThrow(ForbiddenException);
    expectNoMutation();
  });

  it('플랫폼 BP 면 403', async () => {
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일',
      accountStatusCode: 'ACTIVE',
      isPlatform: true,
    });
    await expect(service.execute(1, dto)).rejects.toThrow(
      new ForbiddenException('플랫폼 BP 는 탈퇴할 수 없습니다.'),
    );
    expectNoMutation();
  });

  it('하위 관리자가 없어도 본인 접속은 끝낸다', async () => {
    await service.execute(1, dto);
    expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({
      where: { adminAccountId: { in: [1] }, revokedAt: null },
      data: { revokedAt: now },
    });
  });

  it('비밀번호가 틀리면 400', async () => {
    await expect(
      service.execute(1, { ...dto, currentPassword: 'wrong-pass-1!' }),
    ).rejects.toThrow(
      new BadRequestException(ADMIN_PASSWORD_MESSAGES.currentMismatch),
    );
    expectNoMutation();
  });

  it('사유가 직접입력인데 상세가 없으면 400', async () => {
    await expect(
      service.execute(1, {
        ...dto,
        reasonCode: 'WD_INPUT',
        reasonDetail: '  ',
      }),
    ).rejects.toThrow(
      new BadRequestException('탈퇴 사유 상세를 입력해 주세요.'),
    );
    expectNoMutation();
  });

  it('트랜잭션을 폐점 제한 시간으로 연다', async () => {
    await service.execute(1, dto);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: STORE_CLOSING_TRANSACTION_TIMEOUT_MS,
    });
  });

  it('진행 중 계약(서명 완료 포함)은 보지 않는다 — 계약 때문에 막지 않는다', async () => {
    await expect(service.execute(1, dto)).resolves.toBeUndefined();
  });

  it('폐점 서비스의 409(퇴근 기록 없는 출근)는 그대로 내보내고 메일을 보내지 않는다', async () => {
    const openCheckIn = new ConflictException({
      code: 'OPEN_CHECK_IN',
      storeId: 101,
      message: '퇴근 기록이 없는 출근이 있어 폐점할 수 없습니다.',
    });
    closings.close.mockRejectedValue(openCheckIn);
    await expect(service.execute(1, dto)).rejects.toBe(openCheckIn);
    expect(mailService.send).not.toHaveBeenCalled();
  });

  it('교착이 두 번 나면 트랜잭션을 처음부터 두 번 열고 409', async () => {
    const deadlock = new Prisma.PrismaClientKnownRequestError('deadlock', {
      code: 'P2034',
      clientVersion: 'test',
    });
    prisma.$transaction.mockRejectedValue(deadlock);
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await expect(service.execute(1, dto)).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(mailService.send).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it('본인은 WITHDRAWN, 하위 관리자는 개인정보를 지우고 INACTIVE 로 바꾸고 점포를 폐점하고 이력과 메일을 남긴다', async () => {
    prisma.adminAccount.findMany.mockResolvedValue([
      { adminAccountId: 2, accountStatusCode: 'ACTIVE' },
      { adminAccountId: 3, accountStatusCode: 'INACTIVE' },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // BP 행
      .mockResolvedValueOnce([]) // 본인 행
      .mockResolvedValueOnce([{ storeId: 101 }, { storeId: 102 }]); // 폐점할 점포

    await service.execute(1, dto);

    // BP 행 → 본인 행 순서로 잠근다 — 하위 관리자 등록 · 수정(lockBp FOR SHARE)이 탈퇴 뒤로 줄을 선다.
    const calls = prisma.$queryRaw.mock.calls as [string[], ...unknown[]][];
    const locks = calls.map((call) => call[0].join('?'));
    expect(locks[0]).toContain('FROM bp_codes');
    expect(locks[0]).toContain('FOR UPDATE');
    expect(calls[0][1]).toBe(7);
    expect(locks[1]).toContain('FROM admin_accounts');
    expect(locks[1]).toContain('FOR UPDATE');
    // 폐점할 점포는 BP 행 · 본인 행 뒤에 읽으며 잠근다 — 잠금을 기다린 뒤 폐점 · 삭제된 행은 조건에서 빠진다.
    expect(locks[2]).toContain('FROM stores');
    expect(locks[2]).toContain('NOT is_deleted');
    expect(locks[2]).toContain('store_status_code <>');
    expect(locks[2]).toContain('FOR NO KEY UPDATE');
    expect(calls[2].slice(1)).toEqual([7, 'CLOSED']);
    expect(prisma.adminAccount.findFirst).toHaveBeenCalledWith({
      where: { adminAccountId: 1, isDeleted: false },
      select: {
        roleTypeCode: true,
        bpCodeId: true,
        passwordHash: true,
        email: true,
        accountStatusCode: true,
      },
    });
    expect(prisma.adminAccount.update).toHaveBeenCalledWith({
      where: { adminAccountId: 1 },
      data: {
        accountStatusCode: 'WITHDRAWN',
        statusChangedAt: now,
        name: null,
        phone: null,
        email: null,
        updatedBy: 1,
        withdrawReasonCode: 'WD_CLOSE',
        withdrawReasonDetail: null,
      },
    });
    const subAdminWhere = {
      bpCodeId: 7,
      adminAccountId: { not: 1 },
      isDeleted: false,
      accountStatusCode: { not: 'WITHDRAWN' },
    };
    expect(prisma.adminAccount.findMany).toHaveBeenCalledWith({
      where: subAdminWhere,
      select: { adminAccountId: true, accountStatusCode: true },
    });
    // 읽은 id 로만 바꾼다 — 이력을 남긴 행과 같은 행. 하위 관리자는 탈퇴가 아니라 미사용 — 개인정보는 모두 지우고,
    // 상태는 사용이던 계정(2)만 미사용으로 바꾼다(3 은 이미 미사용, 2026-11-04 사용자 지정).
    expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
      where: { adminAccountId: { in: [2, 3] } },
      data: { name: null, phone: null, email: null, updatedBy: 1 },
    });
    expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
      where: { adminAccountId: { in: [2] } },
      data: { accountStatusCode: 'INACTIVE', statusChangedAt: now },
    });
    expect(prisma.adminAccount.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountStatusCode: 'WITHDRAWN' }),
      }),
    );
    // 남은 접근 토큰으로 지운 개인정보를 다시 적지 못하게 본인 · 하위 관리자의 접속을 끝낸다.
    expect(prisma.adminSession.updateMany).toHaveBeenCalledWith({
      where: { adminAccountId: { in: [1, 2, 3] }, revokedAt: null },
      data: { revokedAt: now },
    });
    expect(prisma.bpCode.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { bpCodeId: 7 },
      select: { tradeName: true, accountStatusCode: true, isPlatform: true },
    });
    expect(prisma.bpCode.update).toHaveBeenCalledWith({
      where: { bpCodeId: 7 },
      data: {
        accountStatusCode: 'WITHDRAWN',
        bizCeoPhone: null,
        bizCeoEmail: null,
        updatedBy: 1,
      },
    });
    // 폐점(점포 상태 · 폐점일 · 점포상태 이력 · 3팀 퇴직)은 폐점 서비스가 같은 트랜잭션에서 한다.
    expect(closings.close).toHaveBeenCalledWith(prisma, [101, 102], 1, now);
    // 폐점은 탈퇴 처리 뒤 마지막이다 — 그 앞에서 직원 · 계정 행을 잠그지 않는다(3팀 점포 → 직원 → 계정 순서).
    const lastWrite = Math.max(
      ...[
        prisma.adminAccount.update,
        prisma.adminAccount.updateMany,
        prisma.adminSession.updateMany,
        prisma.bpCode.update,
        prisma.adminChangeHistory.createMany,
        prisma.bpChangeHistory.create,
      ].flatMap((m) => m.mock.invocationCallOrder),
    );
    expect(closings.close.mock.invocationCallOrder[0]).toBeGreaterThan(
      lastWrite,
    );
    expect(prisma.adminChangeHistory.createMany).toHaveBeenCalledWith({
      // 상태가 바뀐 계정만 — BP 마스터는 탈퇴, 사용이던 하위 관리자는 미사용. 이미 미사용(3)은 남기지 않는다
      data: [
        { adminAccountId: 1, beforeValue: '사용', afterValue: '탈퇴' },
        { adminAccountId: 2, beforeValue: '사용', afterValue: '미사용' },
      ].map((row) => ({
        ...row,
        field: '계정 상태',
        changedBy: 1,
        changedAt: now,
      })),
    });
    expect(prisma.bpChangeHistory.create).toHaveBeenCalledWith({
      data: {
        bpCodeId: 7,
        field: 'BP상태',
        beforeValue: '사용',
        afterValue: '탈퇴',
        note: '폐업·사업 종료',
        changedBy: 1,
        changedAt: now,
      },
    });
    expect(mailService.send).toHaveBeenCalledWith({
      templateCode: 'EMAIL_WITHDRAW_DONE',
      to: 'master@whale.kr',
      variables: { BP이름: '웨일분식', 탈퇴일: '2026-10-27' },
      adminAccountId: 1,
    });
  });

  it('직접입력이면 상세를 본인 행과 BP 이력 비고에 남긴다', async () => {
    await service.execute(1, {
      ...dto,
      reasonCode: 'WD_INPUT',
      reasonDetail: '다른 법인으로 옮깁니다',
    });
    expect(prisma.adminAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          withdrawReasonCode: 'WD_INPUT',
          withdrawReasonDetail: '다른 법인으로 옮깁니다',
        }),
      }),
    );
    expect(prisma.bpChangeHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ note: '다른 법인으로 옮깁니다' }),
    });
  });

  it('직접입력이 아니면 상세를 보내도 저장하지 않는다', async () => {
    await service.execute(1, { ...dto, reasonDetail: '무시될 값' });
    expect(prisma.adminAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ withdrawReasonDetail: null }),
      }),
    );
  });

  it('하위 관리자 · 폐점할 점포가 없으면 그 쓰기를 건너뛴다', async () => {
    await service.execute(1, dto);
    expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    // 폐점할 점포가 없으면 폐점 서비스가 빈 결과로 바로 돌아온다(잠그지 않는다).
    expect(closings.close).toHaveBeenCalledWith(prisma, [], 1, now);
    expect(prisma.adminChangeHistory.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ adminAccountId: 1 })],
    });
    expect(prisma.bpCode.update).toHaveBeenCalled();
  });

  it('이메일이 없으면 메일을 보내지 않는다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(master({ email: null }));
    await service.execute(1, dto);
    expect(prisma.adminAccount.update).toHaveBeenCalled();
    expect(mailService.send).not.toHaveBeenCalled();
  });

  it('메일 설정이 없어도 탈퇴는 된다', async () => {
    service = await build(null);
    await expect(service.execute(1, dto)).resolves.toBeUndefined();
    expect(prisma.adminAccount.update).toHaveBeenCalled();
  });

  it('메일 발송이 실패해도 탈퇴는 성공한다', async () => {
    mailService.send.mockRejectedValue(new Error('smtp down'));
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await expect(service.execute(1, dto)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
