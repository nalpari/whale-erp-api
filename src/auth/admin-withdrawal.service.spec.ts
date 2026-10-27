/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining 은 any 를 돌려준다 */
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OPTIONAL_MAIL_SERVICE } from '../mail/mail.module';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_PASSWORD_MESSAGES } from './admin-password-policy';
import { AdminWithdrawalService } from './admin-withdrawal.service';
import { hashPassword } from './password';

describe('AdminWithdrawalService.getEligibility', () => {
  let service: AdminWithdrawalService;
  let prisma: {
    adminAccount: { findFirst: jest.Mock; count: jest.Mock };
    bpCode: { findUniqueOrThrow: jest.Mock };
    store: { count: jest.Mock; findMany: jest.Mock };
    contract: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      adminAccount: { findFirst: jest.fn(), count: jest.fn() },
      bpCode: { findUniqueOrThrow: jest.fn() },
      store: { count: jest.fn(), findMany: jest.fn() },
      contract: { count: jest.fn() },
    };
    service = (
      await Test.createTestingModule({
        providers: [
          AdminWithdrawalService,
          { provide: PrismaService, useValue: prisma },
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

  it('탈퇴한 계정이면 404', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue(null); // isDeleted:false 필터로 이미 걸러짐
    await expect(service.getEligibility(1)).rejects.toThrow(NotFoundException);
  });

  it('BP명·하위 관리자 수·점포 수·진행중 계약 여부를 반환한다', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 7,
    });
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일분식',
    });
    prisma.adminAccount.count.mockResolvedValue(6);
    prisma.store.count.mockResolvedValue(11);
    // contracts 테이블은 1팀 stores 와 Prisma 관계로 잇지 않는다(schema.prisma 머리말) —
    // storeId 는 정수 칸만 있어 그 BP 의 점포 id 를 먼저 받아 와야 한다.
    prisma.store.findMany.mockResolvedValue([
      { storeId: 101 },
      { storeId: 102 },
    ]);
    prisma.contract.count.mockResolvedValue(1);

    const result = await service.getEligibility(1);

    expect(result).toEqual({
      bpName: '웨일분식',
      adminCount: 6,
      storeCount: 11,
      hasInProgressContract: true,
    });
    expect(prisma.bpCode.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { bpCodeId: 7 },
      select: { tradeName: true },
    });
    expect(prisma.adminAccount.count).toHaveBeenCalledWith({
      where: {
        bpCodeId: 7,
        adminAccountId: { not: 1 },
        isDeleted: false,
        accountStatusCode: { not: 'WITHDRAWN' },
      },
    });
    expect(prisma.store.count).toHaveBeenCalledWith({
      where: {
        bpCodeId: 7,
        isDeleted: false,
        storeStatusCode: { not: 'CLOSED' },
      },
    });
    expect(prisma.contract.count).toHaveBeenCalledWith({
      where: {
        storeId: { in: [101, 102] },
        status: {
          in: ['DRAFT', 'PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED'],
        },
      },
    });
  });

  it('진행중 계약이 없으면 hasInProgressContract 는 false', async () => {
    prisma.adminAccount.findFirst.mockResolvedValue({
      roleTypeCode: 'BM',
      bpCodeId: 7,
    });
    prisma.bpCode.findUniqueOrThrow.mockResolvedValue({
      tradeName: '웨일분식',
    });
    prisma.adminAccount.count.mockResolvedValue(0);
    prisma.store.count.mockResolvedValue(0);
    prisma.store.findMany.mockResolvedValue([]);
    prisma.contract.count.mockResolvedValue(0);

    const result = await service.getEligibility(1);

    expect(result.hasInProgressContract).toBe(false);
  });
});

describe('AdminWithdrawalService.execute', () => {
  const PASSWORD = 'whale-2026!';
  const dto = { currentPassword: PASSWORD, reasonCode: 'WD_CLOSE' };
  const now = new Date('2026-10-27T05:00:00Z');

  let service: AdminWithdrawalService;
  let passwordHash: string;
  let mailService: { send: jest.Mock };
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
    store: { findMany: jest.Mock; updateMany: jest.Mock };
    contract: { count: jest.Mock };
    adminChangeHistory: { createMany: jest.Mock };
    storeChangeHistory: { createMany: jest.Mock };
    bpChangeHistory: { create: jest.Mock };
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
          { provide: PrismaService, useValue: prisma },
          { provide: OPTIONAL_MAIL_SERVICE, useValue: mail },
        ],
      }).compile()
    ).get(AdminWithdrawalService);

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(now);
    prisma = {
      $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(prisma)),
      $queryRaw: jest.fn(),
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
      // 첫 호출은 진행 중 계약 확인용(그 BP 의 모든 점포), 둘째는 폐점할 점포 목록이다.
      store: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      contract: { count: jest.fn().mockResolvedValue(0) },
      adminChangeHistory: { createMany: jest.fn() },
      storeChangeHistory: { createMany: jest.fn() },
      bpChangeHistory: { create: jest.fn() },
    };
    mailService = { send: jest.fn().mockResolvedValue(undefined) };
    service = await build(mailService);
  });

  afterEach(() => jest.useRealTimers());

  const expectNoMutation = () => {
    expect(prisma.adminAccount.update).not.toHaveBeenCalled();
    expect(prisma.adminAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.bpCode.update).not.toHaveBeenCalled();
    expect(prisma.store.updateMany).not.toHaveBeenCalled();
    expect(prisma.adminChangeHistory.createMany).not.toHaveBeenCalled();
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

  it('진행 중인 근로계약이 있으면 400', async () => {
    prisma.store.findMany.mockResolvedValueOnce([
      { storeId: 101 },
      { storeId: 102 },
    ]);
    prisma.contract.count.mockResolvedValue(1);
    await expect(service.execute(1, dto)).rejects.toThrow(
      new BadRequestException(
        '진행 중인 근로계약이 있어 탈퇴할 수 없습니다. 근로계약을 모두 종료한 뒤 다시 시도해 주세요.',
      ),
    );
    // 조건 조회(getEligibility)와 같은 점포 범위 · 같은 상태로 센다.
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { bpCodeId: 7 },
      select: { storeId: true },
    });
    expect(prisma.contract.count).toHaveBeenCalledWith({
      where: {
        storeId: { in: [101, 102] },
        status: {
          in: ['DRAFT', 'PENDING_SEND', 'PENDING_SIGNATURE', 'SIGNED'],
        },
      },
    });
    expectNoMutation();
  });

  it('본인·하위 관리자를 전부 WITHDRAWN 처리하고 점포를 폐점하고 이력과 메일을 남긴다', async () => {
    prisma.adminAccount.findMany.mockResolvedValue([
      { adminAccountId: 2, accountStatusCode: 'ACTIVE' },
      { adminAccountId: 3, accountStatusCode: 'INACTIVE' },
    ]);
    prisma.store.findMany
      .mockResolvedValueOnce([{ storeId: 101 }, { storeId: 102 }])
      .mockResolvedValueOnce([
        { storeId: 101, storeStatusCode: 'OPERATING' },
        { storeId: 102, storeStatusCode: 'NOT_OPERATING' },
      ]);

    await service.execute(1, dto);

    expect(prisma.$queryRaw).toHaveBeenCalled(); // 본인 행 잠금
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
    expect(prisma.adminAccount.updateMany).toHaveBeenCalledWith({
      where: subAdminWhere,
      data: {
        accountStatusCode: 'WITHDRAWN',
        statusChangedAt: now,
        name: null,
        phone: null,
        email: null,
      },
    });
    expect(prisma.bpCode.update).toHaveBeenCalledWith({
      where: { bpCodeId: 7 },
      data: {
        accountStatusCode: 'WITHDRAWN',
        bizCeoPhone: null,
        bizCeoEmail: null,
      },
    });
    expect(prisma.store.findMany).toHaveBeenLastCalledWith({
      where: {
        bpCodeId: 7,
        isDeleted: false,
        storeStatusCode: { not: 'CLOSED' },
      },
      select: { storeId: true, storeStatusCode: true },
    });
    expect(prisma.store.updateMany).toHaveBeenCalledWith({
      where: { storeId: { in: [101, 102] } },
      data: { storeStatusCode: 'CLOSED', closedDate: now },
    });
    const retainEndDate = new Date('2031-10-27T00:00:00Z'); // 한국 오늘 + 5년
    expect(prisma.storeChangeHistory.createMany).toHaveBeenCalledWith({
      data: [
        { storeId: 101, beforeValue: '운영' },
        { storeId: 102, beforeValue: '미운영' },
      ].map((row) => ({
        ...row,
        field: '점포상태',
        afterValue: '폐점',
        changedBy: 1,
        changedAt: now,
        retainEndDate,
      })),
    });
    expect(prisma.adminChangeHistory.createMany).toHaveBeenCalledWith({
      data: [
        { adminAccountId: 1, beforeValue: '사용' },
        { adminAccountId: 2, beforeValue: '사용' },
        { adminAccountId: 3, beforeValue: '미사용' },
      ].map((row) => ({
        ...row,
        field: '계정 상태',
        afterValue: '탈퇴',
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
    expect(prisma.store.updateMany).not.toHaveBeenCalled();
    expect(prisma.storeChangeHistory.createMany).not.toHaveBeenCalled();
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
