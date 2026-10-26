import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE } from '../storage/storage.module';
import { ContractDeliveryService } from './contract-delivery.service';
import { ContractsService } from './contracts.service';
import { UpdateWorkerDto } from './dto/update-worker.dto';

// 날인 전 근로자 정보 수정(WHALEERP-125 「본인 대조」 · 126, 2026-10-16)
// 보내기(ContractDeliveryService)는 따로 시험한다 — 여기서는 무엇을 넘기는지만 본다. 기본은 앱으로 받음(보낼 것 없음)
const delivery = {
  prepare: jest.fn<
    Promise<unknown>,
    [unknown, Record<string, unknown>, Date]
  >(),
  dispatch: jest.fn<Promise<boolean>, [unknown, number]>(),
};
beforeEach(() => {
  delivery.prepare.mockReset().mockResolvedValue(null);
  // 보냈거나 보낼 것이 없다(true). 그사이 초대가 무효가 돼 보내지 않은 경우는 false 로 따로 본다
  delivery.dispatch.mockReset().mockResolvedValue(true);
});

describe('ContractsService.updateWorker', () => {
  let service: ContractsService;
  let scope: { canManageStaffAt: jest.Mock };
  let tx: {
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    contract: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock<
        Promise<{ count: number }>,
        [Prisma.ContractUpdateManyArgs]
      >;
    };
    account: { findMany: jest.Mock };
    adminAccount: { findFirst: jest.Mock };
    roleGroupMenu: { count: jest.Mock };
    staffMember: {
      findFirst: jest.Mock;
      update: jest.Mock<Promise<unknown>, [Prisma.StaffMemberUpdateArgs]>;
    };
    contractParty: {
      upsert: jest.Mock<Promise<unknown>, [Prisma.ContractPartyUpsertArgs]>;
    };
    contractStatusHistory: {
      create: jest.Mock<
        Promise<unknown>,
        [Prisma.ContractStatusHistoryCreateArgs]
      >;
    };
  };
  let prisma: { $transaction: jest.Mock; contract: { findUnique: jest.Mock } };

  const PHONE = '01090145563';
  const SENT = new Date('2026-10-10T01:00:00Z');
  const DEADLINE = new Date('2026-11-09T01:00:00Z');
  // 기본은 계정이 있는 번호로 받은 서명 대기(앱으로 받음 — 소속 추가)
  const row = (over: Record<string, unknown> = {}) => ({
    status: 'PENDING_SIGNATURE',
    storeId: 11,
    staffMemberId: 3,
    startDate: new Date('2026-11-01T00:00:00Z'),
    endDate: null,
    draftAction: 'AFFILIATION_CONFIRM',
    sentAt: SENT,
    signDeadlineAt: DEADLINE,
    staffMember: { phone: PHONE, joinStatus: 'DRAFT', candidateAccountId: 42 },
    contractWorkDays: [
      {
        weekday: 'MON',
        startTime: new Date('1970-01-01T09:00:00Z'),
        endTime: new Date('1970-01-01T13:00:00Z'),
      },
    ],
    ...over,
  });
  const dto = (over: Partial<UpdateWorkerDto> = {}): UpdateWorkerDto => ({
    name: '남도현',
    phone: PHONE,
    birthDate: '1998-07-12',
    gender: 'MALE',
    isForeigner: false,
    ...over,
  });

  beforeEach(async () => {
    scope = { canManageStaffAt: jest.fn().mockResolvedValue(true) };
    tx = {
      // 재입사 사슬 조회(linkedRecords) — 기본은 이은 레코드가 없다
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      contract: {
        findUnique: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest
          .fn<Promise<{ count: number }>, [Prisma.ContractUpdateManyArgs]>()
          .mockResolvedValue({ count: 1 }),
      },
      account: { findMany: jest.fn().mockResolvedValue([]) },
      // 근로계약 관리 메뉴 권한(WHALEERP-592) — 기본은 있다
      adminAccount: {
        findFirst: jest.fn().mockResolvedValue({ roleGroupId: 7 }),
      },
      roleGroupMenu: { count: jest.fn().mockResolvedValue(1) },
      staffMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn<Promise<unknown>, [Prisma.StaffMemberUpdateArgs]>(),
      },
      contractParty: {
        upsert: jest.fn<Promise<unknown>, [Prisma.ContractPartyUpsertArgs]>(),
      },
      contractStatusHistory: {
        create: jest.fn<
          Promise<unknown>,
          [Prisma.ContractStatusHistoryCreateArgs]
        >(),
      },
    };
    prisma = {
      $transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
      // 트랜잭션 밖 — 업무 범위 확인
      contract: {
        findUnique: jest.fn().mockResolvedValue({
          storeId: 11,
          staffMember: {
            account: { isHqSharingConsented: false },
            phone: PHONE,
          },
        }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminScopeService, useValue: scope },
        { provide: STORAGE, useValue: null },
        { provide: ContractDeliveryService, useValue: delivery },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('서명 대기(앱으로 받음)면 당사자 정보를 고치고 서명 대기 그대로 곧바로 다시 보낸다 — 새 기한, 보내기 직전 값을 넘긴다', async () => {
    await expect(
      service.updateWorker(9, 7, dto({ gender: 'FEMALE', isForeigner: true })),
    ).resolves.toEqual({
      contractId: 7,
      staffMemberId: 3,
      status: 'PENDING_SIGNATURE',
      draftAction: 'AFFILIATION_CONFIRM',
    });
    // 상태가 그대로라 전환 · 이력은 없다
    expect(tx.contract.updateMany).not.toHaveBeenCalled();
    expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
    const [party] = tx.contractParty.upsert.mock.calls[0];
    expect(party.update).toMatchObject({
      enteredName: '남도현',
      enteredPhone: PHONE,
      enteredBirthDate: new Date('1998-07-12T00:00:00.000Z'),
      enteredGender: 'FEMALE',
      isForeigner: true,
    });
    expect(delivery.prepare).toHaveBeenCalledWith(
      tx,
      {
        contractId: 7,
        storeId: 11,
        phone: PHONE,
        joined: false,
        draftAction: 'AFFILIATION_CONFIRM',
        before: {
          status: 'PENDING_SIGNATURE',
          sentAt: SENT,
          signDeadlineAt: DEADLINE,
          draftAction: 'AFFILIATION_CONFIRM',
          staffMemberId: 3,
          staffMember: {
            phone: PHONE,
            joinStatus: 'DRAFT',
            candidateAccountId: 42,
          },
        },
        statusChanged: false,
        phoneChanged: false,
        replacedContracts: false,
      },
      expect.any(Date),
    );
    // 보내기는 커밋 뒤
    expect(delivery.dispatch).toHaveBeenCalledWith(null, 9);
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      delivery.dispatch.mock.invocationCallOrder[0],
    );
    // 번호가 그대로면 중복 · 겹침 · 초대 판별을 다시 하지 않는다
    expect(tx.contract.findMany).not.toHaveBeenCalled();
    // 계정 조회는 재입사 레코드를 잇는 한 번뿐이다(WHALEERP-615) — 판별하면 한 번 더 조회한다
    expect(tx.account.findMany).toHaveBeenCalledTimes(1);
  });

  it('수정 요청이면 곧바로 서명 대기로 다시 보낸다 — 발송 대기를 거치지 않는다(2026-10-19 재영)', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({ status: 'CORRECTION_REQUESTED' }),
    );
    await service.updateWorker(9, 7, dto());
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'CORRECTION_REQUESTED' },
      data: { status: 'PENDING_SIGNATURE' },
    });
    expect(delivery.prepare.mock.calls[0][1]).toMatchObject({
      statusChanged: true,
    });
  });

  it('발송 대기(가입 초대)면 상태 그대로 가입 초대를 새로 보낸다', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({
        status: 'PENDING_SEND',
        draftAction: 'SIGNUP_INVITE',
        staffMember: {
          phone: PHONE,
          joinStatus: 'INVITED',
          candidateAccountId: null,
        },
      }),
    );
    await service.updateWorker(9, 7, dto({ name: '남도연' }));
    expect(tx.contract.updateMany).not.toHaveBeenCalled();
    expect(tx.contractStatusHistory.create).not.toHaveBeenCalled();
    expect(tx.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 3 },
      data: { name: '남도연', phone: PHONE, previousStaffMemberId: null },
    });
    expect(delivery.prepare.mock.calls[0][1]).toMatchObject({
      draftAction: 'SIGNUP_INVITE',
      statusChanged: false,
    });
  });

  it.each(['DRAFT', 'SIGNED', 'REJECTED', 'EXPIRED', 'ENDED'])(
    '%s 이면 409 CONTRACT_STATUS_CONFLICT — 아무것도 쓰지 않는다',
    async (status) => {
      tx.contract.findUnique.mockResolvedValue(row({ status }));
      const error = await service
        .updateWorker(9, 7, dto())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'CONTRACT_STATUS_CONFLICT',
        status,
      });
      expect(tx.contractParty.upsert).not.toHaveBeenCalled();
    },
  );

  it('번호를 바꾸면 새 번호로 재직 확인 · 진행 중 계약 · 근무 시간 겹침 · 초대 유형 판별을 다시 한다', async () => {
    await service.updateWorker(9, 7, dto({ phone: '01011112222' }));
    expect(tx.staffMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: 11,
          phone: '01011112222',
          staffMemberId: { not: 3 },
        }) as object,
      }),
    );
    // 같은 점포 진행 중 계약(자기 빼고) · 다른 점포 근무 시간 겹침
    expect(tx.contract.findMany).toHaveBeenCalledTimes(2);
    expect(tx.account.findMany).toHaveBeenCalled();
    // 새 번호에는 계정이 없다 → 가입 초대를 보내 발송 대기로. 옛 번호의 초대는 보내기(prepare)가 무효로 한다
    expect(tx.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: { status: 'PENDING_SEND' },
    });
    expect(delivery.prepare.mock.calls[0][1]).toMatchObject({
      phone: '01011112222',
      draftAction: 'SIGNUP_INVITE',
      statusChanged: true,
      phoneChanged: true,
    });
    expect(tx.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 3 },
      data: {
        name: '남도현',
        phone: '01011112222',
        candidateAccountId: null,
        previousStaffMemberId: null,
      },
    });
    // 지금 번호와 새 번호를 둘 다 잠근다
    const locked = tx.$executeRaw.mock.calls.map((c: unknown[]) => c[1]);
    expect(locked).toEqual(
      expect.arrayContaining([`contracts:${PHONE}`, 'contracts:01011112222']),
    );
  });

  it('번호 잠금 다음 직원 행을 계약 행보다 먼저 잠근다 — 가입 전 직원 행(이름 · 번호)을 쓰므로', async () => {
    await service.updateWorker(9, 7, dto());
    // 직원 행(FOR NO KEY UPDATE) → 계약 행(FOR UPDATE) — 이어 쓰기 · 퇴직 확정 · 직원 앱 날인과 같은 순서(api #104)
    const sql = (tx.$executeRaw.mock.calls as unknown[][]).map((c) =>
      Array.isArray(c[0]) ? (c[0] as string[]).join('?') : '',
    );
    const staff = sql.findIndex((s) =>
      /FROM staff_members .* FOR NO KEY UPDATE$/.test(s),
    );
    const contract = sql.findIndex((s) =>
      /FROM contracts .* FOR UPDATE$/.test(s),
    );
    expect(staff).toBeGreaterThanOrEqual(0);
    expect(staff).toBeLessThan(contract);
    expect((tx.$executeRaw.mock.calls as unknown[][])[staff][1]).toBe(3);
  });

  it('새 번호로 같은 점포 진행 중 계약이 있으면 409 CONTRACT_IN_PROGRESS', async () => {
    tx.contract.findMany.mockResolvedValueOnce([
      {
        contractId: 5,
        status: 'PENDING_SEND',
        staffMemberId: 8,
        startDate: null,
        endDate: null,
        staffMember: { name: '다른사람' },
      },
    ]);
    const error = await service
      .updateWorker(9, 7, dto({ phone: '01011112222' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'CONTRACT_IN_PROGRESS',
    });
    expect(tx.contractParty.upsert).not.toHaveBeenCalled();
  });

  it('새 번호의 같은 점포 임시저장을 대체하려면 삭제 권한도 있어야 한다 — 없으면 409 전에 403(api #97 리뷰)', async () => {
    tx.contract.findMany.mockResolvedValueOnce([
      {
        contractId: 5,
        status: 'DRAFT',
        staffMemberId: 8,
        startDate: null,
        endDate: null,
        staffMember: { name: '다른사람' },
      },
    ]);
    tx.roleGroupMenu.count.mockImplementation(
      ({ where }: { where: { OR: Record<string, boolean>[] } }) =>
        Promise.resolve(where.OR.some((o) => o.isDeletable) ? 0 : 1),
    );
    // 대체를 확인하지 않은 첫 요청 — 409 로 이름을 보이기 전에 403
    const error = await service
      .updateWorker(9, 7, dto({ phone: '01011112222' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    // 보낸 계약이라 이어 쓰라고 하지 않는다
    expect((error as ForbiddenException).message).toContain(
      '삭제 권한이 있는 관리자에게',
    );
    expect(
      JSON.stringify((error as ForbiddenException).getResponse()),
    ).not.toContain('다른사람');
    expect(tx.contractParty.upsert).not.toHaveBeenCalled();
  });

  it('동의로만 보이는 관리자가 번호를 바꾸면 403 — 트랜잭션 전에 막는다', async () => {
    // 계약 직원의 동의로만 보인다 — 점포 단위 범위는 없다
    prisma.contract.findUnique.mockResolvedValue({
      storeId: 11,
      staffMember: { account: { isHqSharingConsented: true }, phone: PHONE },
    });
    scope.canManageStaffAt.mockImplementation(
      (_: number, __: number, consented: boolean) => Promise.resolve(consented),
    );
    await expect(
      service.updateWorker(9, 7, dto({ phone: '01011112222' })),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('판별값이 비어 있는 옛 계약의 가입 전 직원은 받을 길이 없어 저장 응답의 처리 결과가 null 이다 — 보냈다고 알리지 않게', async () => {
    tx.contract.findUnique.mockResolvedValue(row({ draftAction: null }));
    await expect(service.updateWorker(9, 7, dto())).resolves.toMatchObject({
      status: 'PENDING_SIGNATURE',
      draftAction: null,
    });
  });

  it('보내기 전에 다른 요청이 초대를 무효로 해 되돌렸으면 지금 상태를 싣고 처리 결과는 null 이다', async () => {
    // dispatch 가 보내지 않았다(false) → 지금 상태를 다시 읽는다. 범위 확인 → (트랜잭션) → 다시 읽기 순서
    delivery.dispatch.mockResolvedValue(false);
    prisma.contract.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce({ status: 'ENDED' });
    await expect(service.updateWorker(9, 7, dto())).resolves.toMatchObject({
      status: 'ENDED',
      draftAction: null,
    });
  });

  it('보냈으면 다시 읽지 않고, 보내지 않았는데 지금 상태를 읽다 실패하면 502 SEND_UNCONFIRMED — 계산한 상태로 답하지 않는다', async () => {
    await service.updateWorker(9, 7, dto());
    // 범위 확인 한 번뿐 — 보낸 뒤 다시 읽지 않는다
    expect(prisma.contract.findUnique).toHaveBeenCalledTimes(1);

    delivery.dispatch.mockResolvedValue(false);
    prisma.contract.findUnique
      .mockResolvedValueOnce(row())
      .mockRejectedValueOnce(new Error('db down'));
    const error = await service
      .updateWorker(9, 7, dto())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as BadGatewayException).getResponse()).toMatchObject({
      code: 'SEND_UNCONFIRMED',
      retryable: false,
      contractId: 7,
    });
  });

  it('가입 완료한 직원 레코드는 두고 계약 당사자 값만 고친다', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({ staffMember: { phone: PHONE, joinStatus: 'JOINED' } }),
    );
    // 저장 응답은 실제로 한 처리 — 가입한 직원은 앱으로 다시 보냈다(즉시 발송)
    await expect(
      service.updateWorker(9, 7, dto({ name: '남도연' })),
    ).resolves.toMatchObject({ draftAction: 'IMMEDIATE_SEND' });
    expect(tx.staffMember.update).not.toHaveBeenCalled();
    expect(tx.contractParty.upsert).toHaveBeenCalled();
  });

  it('가입 완료한 직원의 번호를 바꾸면 400 — 계정의 번호가 기준이다', async () => {
    tx.contract.findUnique.mockResolvedValue(
      row({ staffMember: { phone: PHONE, joinStatus: 'JOINED' } }),
    );
    await expect(
      service.updateWorker(9, 7, dto({ phone: '01011112222' })),
    ).rejects.toThrow('가입한 직원의 휴대전화번호는 바꿀 수 없습니다');
    expect(tx.contractParty.upsert).not.toHaveBeenCalled();
  });

  it('계약 시작일 기준 만 19세 미만이면 400', async () => {
    await expect(
      service.updateWorker(9, 7, dto({ birthDate: '2010-01-01' })),
    ).rejects.toThrow(BadRequestException);
    expect(tx.contractParty.upsert).not.toHaveBeenCalled();
  });
});
