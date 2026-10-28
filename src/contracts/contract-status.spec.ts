import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma } from '@prisma/client';
import { SIGNED_ONCE } from './signed-contract';
import {
  applyStartedTerms,
  refillHiredDate,
  refixHiredDate,
  canTransition,
  fillHiredDate,
  rejectContract,
  requestCorrection,
  signContract,
  transition,
  transitionMany,
  transitionManyWithHistory,
  TRANSITIONS,
} from './contract-status';

// 계약 하나 — 잠근 뒤 읽는 값. 기본은 날인 기한이 남은 서명 대기다.
const db = (
  row: {
    status: ContractStatus | null;
    signDeadlineAt?: Date | null;
    staffMemberId?: number;
    startDate?: Date | null;
  } | null = {
    status: 'PENDING_SIGNATURE',
    signDeadlineAt: new Date('2026-11-01T00:00:00Z'),
  },
) => {
  const calls: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    () => {
      calls.push(name);
      return Promise.resolve(value);
    };
  return {
    calls,
    $executeRaw: jest.fn(track('lock', 1)),
    contract: {
      findUnique: jest.fn(track('read', row)),
      updateMany: jest.fn(track('update', { count: 1 })),
      updateManyAndReturn: jest.fn(
        track('updateMany', [{ contractId: 1 }, { contractId: 2 }]),
      ),
    },
    contractStatusHistory: {
      create: jest.fn(track('history', {})),
      createManyAndReturn: jest.fn(
        track('histories', [
          { contractId: 1, contractStatusHistoryId: 101 },
          { contractId: 2, contractStatusHistoryId: 102 },
        ]),
      ),
    },
    staffMember: {
      updateMany: jest.fn(track('hiredDate', { count: 1 })),
    },
  };
};
type Db = ReturnType<typeof db>;
const tx = (d: Db) => d as unknown as Prisma.TransactionClient;

/** 409 응답 본문. 409 가 아니면 실패한다. */
const conflictOf = async (run: Promise<unknown>) => {
  const e: unknown = await run.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ConflictException);
  return (e as ConflictException).getResponse() as Record<string, unknown>;
};

describe('전환 표', () => {
  it('거부 · 만료는 재발송으로 서명 대기 · 발송 대기로 돌아가고(WHALEERP-153), 종료는 끝 상태다 — 새 계약으로', () => {
    for (const s of ['REJECTED', 'EXPIRED'] as const)
      expect(TRANSITIONS[s]).toEqual(['PENDING_SIGNATURE', 'PENDING_SEND']);
    expect(TRANSITIONS.ENDED).toEqual([]);
  });

  it('체결 완료는 종료로만 간다 — 내용을 바꾸려면 새 계약으로 대체한다', () => {
    expect(TRANSITIONS.SIGNED).toEqual(['ENDED']);
  });

  it('거부 · 만료는 서명 대기에서만 간다 — 발송 대기는 초대만 만료되고 재발송할 수 있게 둔다(api #150 리뷰)', () => {
    const statuses = Object.keys(TRANSITIONS) as ContractStatus[];
    for (const to of ['REJECTED', 'EXPIRED'] as const)
      expect(statuses.filter((s) => canTransition(s, to))).toEqual([
        'PENDING_SIGNATURE',
      ]);
  });

  // 날인은 서명 대기에서, 종이 계약 등록(날인본을 올려 발송 · 날인 없이 체결 완료, CTR-23)은 임시저장에서 간다.
  it('체결 완료는 서명 대기(날인)와 임시저장(종이 계약 등록)에서만 간다', () => {
    const statuses = Object.keys(TRANSITIONS) as ContractStatus[];
    expect(statuses.filter((s) => canTransition(s, 'SIGNED'))).toEqual([
      'DRAFT',
      'PENDING_SIGNATURE',
    ]);
  });
});

describe('transition', () => {
  it('계약 행을 잠그고 읽은 뒤, 읽은 상태를 조건으로 바꾸고 이력을 남긴다', async () => {
    const d = db();
    await expect(
      transition(tx(d), 7, 'ENDED', 'ADMIN', {
        data: { rejectReason: null },
      }),
    ).resolves.toBe('PENDING_SIGNATURE');

    expect(d.calls).toEqual(['lock', 'read', 'update', 'history']);
    expect(d.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: { rejectReason: null, status: 'ENDED' },
    });
    expect(d.contractStatusHistory.create).toHaveBeenCalledWith({
      data: {
        contractId: 7,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'ENDED',
        actor: 'ADMIN',
      },
    });
  });

  it('없는 계약이면 404', async () => {
    await expect(transition(tx(db(null)), 7, 'ENDED', 'ADMIN')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('표에 없는 전환이면 아무것도 쓰지 않고 지금 상태를 담아 409', async () => {
    const d = db({ status: 'SIGNED' });
    const body = await conflictOf(transition(tx(d), 7, 'SIGNED', 'STAFF'));
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'SIGNED',
      message:
        '이미 체결 완료된 근로계약입니다. 화면을 새로 고쳐 지금 상태를 확인해 주세요',
    });
    expect(d.contract.updateMany).not.toHaveBeenCalled();
    expect(d.contractStatusHistory.create).not.toHaveBeenCalled();
  });

  it('from 을 주면 표가 허락해도 그 상태에서만 바꾼다', async () => {
    const d = db({ status: 'PENDING_SEND' });
    await conflictOf(
      transition(tx(d), 7, 'ENDED', 'ADMIN', { from: ['PENDING_SIGNATURE'] }),
    );
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });

  it('조건부 갱신이 0건이면(그사이 바뀜) 다시 읽은 상태로 409 — 이력을 남기지 않는다', async () => {
    const d = db();
    d.contract.updateMany.mockResolvedValue({ count: 0 });
    d.contract.findUnique
      .mockResolvedValueOnce({ status: 'PENDING_SIGNATURE' })
      .mockResolvedValueOnce({ status: 'EXPIRED' });

    const body = await conflictOf(transition(tx(d), 7, 'SIGNED', 'STAFF'));
    expect(body.status).toBe('EXPIRED');
    expect(d.contractStatusHistory.create).not.toHaveBeenCalled();
  });
});

describe('transitionMany', () => {
  it('조건과 이전 상태로 한 번에 바꾸고 바뀐 계약마다 이력을 남긴다', async () => {
    const d = db();
    const where = { signDeadlineAt: { lte: new Date('2026-10-14') } };
    await expect(
      transitionMany(tx(d), where, 'PENDING_SIGNATURE', 'EXPIRED', 'SYSTEM'),
    ).resolves.toEqual([1, 2]);

    expect(d.contract.updateManyAndReturn).toHaveBeenCalledWith({
      where: { ...where, status: 'PENDING_SIGNATURE' },
      data: { status: 'EXPIRED' },
      select: { contractId: true },
    });
    expect(d.contractStatusHistory.createManyAndReturn).toHaveBeenCalledWith({
      data: [1, 2].map((contractId) => ({
        contractId,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'EXPIRED',
        actor: 'SYSTEM',
      })),
      select: { contractId: true, contractStatusHistoryId: true },
    });
  });

  it('이력 번호도 받으려면 transitionManyWithHistory — 만료 알림의 사건 키(상태 이력 ID)', async () => {
    await expect(
      transitionManyWithHistory(
        tx(db()),
        {},
        'PENDING_SIGNATURE',
        'EXPIRED',
        'SYSTEM',
      ),
    ).resolves.toEqual([
      { contractId: 1, historyId: 101 },
      { contractId: 2, historyId: 102 },
    ]);
  });

  it('바뀐 계약이 없으면 이력을 쓰지 않는다', async () => {
    const d = db();
    d.contract.updateManyAndReturn.mockResolvedValue([]);
    await expect(
      transitionMany(tx(d), {}, 'PENDING_SIGNATURE', 'EXPIRED', 'SYSTEM'),
    ).resolves.toEqual([]);
    expect(d.contractStatusHistory.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('표에 없는 전환은 DB 에 묻기 전에 막는다', async () => {
    const d = db();
    await conflictOf(transitionMany(tx(d), {}, 'SIGNED', 'EXPIRED', 'SYSTEM'));
    expect(d.contract.updateManyAndReturn).not.toHaveBeenCalled();
  });
});

describe('signContract (직원 날인)', () => {
  const now = new Date('2026-10-14T00:00:00Z');

  it('서명 대기를 체결 완료로 바꾸고 직원 처리로 이력을 남긴다', async () => {
    const d = db();
    await signContract(tx(d), 7, now);
    expect(d.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: { status: 'SIGNED' },
    });
    expect(d.contractStatusHistory.create).toHaveBeenCalledWith({
      data: {
        contractId: 7,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'SIGNED',
        actor: 'STAFF',
      },
    });
  });

  it('체결 완료한 뒤 직원 레코드의 빈 입사일을 계약 시작일로 채운다 (WHALEERP-613)', async () => {
    const startDate = new Date('2026-11-01T00:00:00.000Z');
    const d = db({
      status: 'PENDING_SIGNATURE',
      signDeadlineAt: new Date('2026-11-01T00:00:00Z'),
      staffMemberId: 3,
      startDate,
    });
    await signContract(tx(d), 7, now);
    expect(d.staffMember.updateMany).toHaveBeenCalledWith({
      where: {
        staffMemberId: 3,
        hiredDate: null,
        // 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝나는 근무다
        OR: [{ retiredDate: null }, { retiredDate: { gte: startDate } }],
      },
      data: { hiredDate: startDate },
    });
    expect(d.calls.indexOf('hiredDate')).toBeGreaterThan(
      d.calls.indexOf('history'),
    );
  });

  it('이미 체결 완료면 처리하지 않고 지금 상태를 알린다', async () => {
    const d = db({ status: 'SIGNED' });
    const body = await conflictOf(signContract(tx(d), 7, now));
    expect(body).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'SIGNED',
    });
    expect(d.contract.updateMany).not.toHaveBeenCalled();
    expect(d.staffMember.updateMany).not.toHaveBeenCalled();
  });

  it('날인 기한이 지났으면 만료 배치 전이어도 받지 않는다 — 상태는 그대로', async () => {
    const d = db({ status: 'PENDING_SIGNATURE', signDeadlineAt: now });
    const body = await conflictOf(signContract(tx(d), 7, now));
    expect(body).toMatchObject({
      code: 'SIGN_DEADLINE_PASSED',
      status: 'PENDING_SIGNATURE',
    });
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });

  it('발송 전(발송 대기)이면 날인할 수 없다', async () => {
    const d = db({ status: 'PENDING_SEND' });
    await conflictOf(signContract(tx(d), 7, now));
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });
});

describe('fillHiredDate (입사일, WHALEERP-613)', () => {
  it('입사일이 빈 직원 레코드에만 계약 시작일을 넣는다 — 갱신 계약은 처음 입사일을 바꾸지 않는다', async () => {
    const d = db();
    const startDate = new Date('2026-09-14T00:00:00.000Z');
    await fillHiredDate(tx(d), 3, startDate);
    expect(d.staffMember.updateMany).toHaveBeenCalledWith({
      where: {
        staffMemberId: 3,
        hiredDate: null,
        // 퇴직일이 시작일보다 앞선 레코드는 채우지 않는다 — 입사 전에 끝나는 근무다
        OR: [{ retiredDate: null }, { retiredDate: { gte: startDate } }],
      },
      data: { hiredDate: startDate },
    });
  });
});

describe('applyStartedTerms (계약 조건을 직원 레코드로, WHALEERP-156)', () => {
  const NOW = new Date('2026-10-27T03:00:00Z');
  const contract = (startDate: string) => ({
    staffMemberId: 3,
    startDate: new Date(`${startDate}T00:00:00Z`),
    employmentType: 'FULL_TIME',
    jobTitle: '매니저',
  });
  const db = (c: unknown, newer: unknown = null) => ({
    contract: {
      findUnique: jest.fn().mockResolvedValue(c),
      findFirst: jest.fn().mockResolvedValue(newer),
    },
    staffMember: { update: jest.fn() },
  });
  const run = (d: ReturnType<typeof db>) =>
    applyStartedTerms(d as unknown as Prisma.TransactionClient, 7, NOW);

  it('시작한 계약이면 직무 · 고용 형태를 직원 레코드로 옮긴다', async () => {
    const d = db(contract('2026-10-01'));
    await run(d);
    expect(d.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 3 },
      data: { employmentType: 'FULL_TIME', jobTitle: '매니저' },
    });
  });

  it('시작 전이면 옮기지 않는다 — 시작일에 하루 배치가 옮긴다', async () => {
    const d = db(contract('2026-11-01'));
    await run(d);
    expect(d.staffMember.update).not.toHaveBeenCalled();
  });

  it('더 늦게 시작해 지금 효력인 체결 완료가 있으면 옮기지 않는다 — 옛 계약을 뒤늦게 올려도(api #157 code-review)', async () => {
    const d = db(contract('2024-01-01'), { contractId: 9 });
    await run(d);
    expect(d.staffMember.update).not.toHaveBeenCalled();
  });

  it('더 늦은 계약은 배치와 같은 기준이다 — 기간이 끝나 닫힌 계약도, 시작일이 같으면 id 가 큰 것(api #157 code-review)', async () => {
    const d = db(contract('2026-10-01'));
    await run(d);
    const [[query]] = d.contract.findFirst.mock.calls as [
      [{ where: { AND: unknown } }],
    ];
    expect(query.where.AND).toEqual([
      SIGNED_ONCE,
      {
        OR: [
          { startDate: { gt: new Date('2026-10-01T00:00:00Z') } },
          {
            startDate: new Date('2026-10-01T00:00:00Z'),
            contractId: { gt: 7 },
          },
        ],
      },
    ]);
  });
});

describe('refixHiredDate (바로잡기 뒤 입사일, api #157 재리뷰 7)', () => {
  const db = (first: unknown) => ({
    staffMember: {
      findUnique: jest.fn().mockResolvedValue({
        hiredDate: new Date('2026-11-01T00:00:00Z'),
        retiredDate: new Date('2026-11-15T00:00:00Z'),
      }),
      update: jest.fn(),
    },
    contract: {
      findFirst: jest
        .fn()
        // 입사일이 닫힌 계약에서 왔다
        .mockResolvedValueOnce({ contractId: 3 })
        .mockResolvedValueOnce(first),
    },
  });
  const run = (d: ReturnType<typeof db>, target: boolean) =>
    refixHiredDate(d as unknown as Prisma.TransactionClient, 9, [3], target);

  it('남은 체결 계약 · 다시 올린 계약 가운데 가장 이른 시작일로 바꾼다', async () => {
    const d = db({ startDate: new Date('2026-10-30T00:00:00Z') });
    await run(d, true);
    expect(d.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 9 },
      data: { hiredDate: new Date('2026-10-30T00:00:00Z') },
    });
  });

  it('출처가 없으면 다시 올린 계약이 붙는 레코드는 비우고, 다른 레코드는 그대로 둔다(셀프 code-review)', async () => {
    const target = db(null);
    await run(target, true);
    expect(target.staffMember.update).toHaveBeenCalledWith({
      where: { staffMemberId: 9 },
      data: { hiredDate: null },
    });
    const other = db(null);
    await run(other, false);
    expect(other.staffMember.update).not.toHaveBeenCalled();
  });
});

describe('refillHiredDate (퇴직 취소 · 퇴직일 변경)', () => {
  it('바로잡기로 닫은 계약은 치지 않는다 — 체결을 거친 계약(SIGNED_ONCE)의 첫 체결만(api #157 셀프 code-review)', async () => {
    const d = {
      contractStatusHistory: { findFirst: jest.fn().mockResolvedValue(null) },
      staffMember: { updateMany: jest.fn() },
    };
    await refillHiredDate(d as unknown as Prisma.TransactionClient, 9, null);
    const [[query]] = d.contractStatusHistory.findFirst.mock.calls as [
      [{ where: { contract: unknown } }],
    ];
    expect(query.where.contract).toMatchObject(SIGNED_ONCE);
  });
});

describe('rejectContract (직원 거부)', () => {
  it('서명 대기를 거부로 바꾸고 앞뒤 공백을 지운 거부 사유를 함께 저장한다', async () => {
    const d = db();
    await rejectContract(tx(d), 7, '  근무 시간이 달라요 ');
    expect(d.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: { rejectReason: '근무 시간이 달라요', status: 'REJECTED' },
    });
    expect(d.contractStatusHistory.create).toHaveBeenCalledWith({
      data: {
        contractId: 7,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'REJECTED',
        actor: 'STAFF',
      },
    });
  });

  it.each([[undefined], [null], ['   ']])(
    '거부 사유는 선택이다(WHALEERP-145) — %p 이면 남기지 않는다',
    async (reason) => {
      const d = db();
      await rejectContract(tx(d), 7, reason);
      expect(d.contract.updateMany).toHaveBeenCalledWith({
        where: { contractId: 7, status: 'PENDING_SIGNATURE' },
        data: { rejectReason: null, status: 'REJECTED' },
      });
    },
  );

  it('거부 사유가 500자를 넘으면 400 — 잠그지도 않는다', async () => {
    const d = db();
    await expect(rejectContract(tx(d), 7, 'x'.repeat(501))).rejects.toThrow(
      BadRequestException,
    );
    expect(d.$executeRaw).not.toHaveBeenCalled();
  });

  it('날인 기한이 지났으면 거부도 받지 않는다 — 상태는 그대로', async () => {
    const now = new Date('2026-11-02T00:00:00Z');
    const d = db({
      status: 'PENDING_SIGNATURE',
      signDeadlineAt: new Date('2026-11-01T00:00:00Z'),
    });
    const body = await conflictOf(rejectContract(tx(d), 7, '사유', now));
    expect(body).toMatchObject({ code: 'SIGN_DEADLINE_PASSED' });
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });

  it('이미 체결 완료면 거부할 수 없다', async () => {
    const d = db({ status: 'SIGNED' });
    await conflictOf(rejectContract(tx(d), 7, '사유'));
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });
});

// 본인 대조(WHALEERP-125 · 126, 2026-10-16) — 가입 값과 계약서 값이 다르면 직원이 수정을 요청한다
describe('수정 요청', () => {
  const NOW = new Date('2026-10-14T00:00:00Z');

  it('서명 대기에서만 수정 요청으로 가고, 수정 요청은 고쳐 저장하면 곧바로 다시 보낸다(서명 대기 · 가입 초대면 발송 대기) · 종료(대체 · 퇴직)', () => {
    const statuses = Object.keys(TRANSITIONS) as ContractStatus[];
    expect(
      statuses.filter((s) => canTransition(s, 'CORRECTION_REQUESTED')),
    ).toEqual(['PENDING_SIGNATURE']);
    expect(TRANSITIONS.CORRECTION_REQUESTED).toEqual([
      'PENDING_SIGNATURE',
      'PENDING_SEND',
      'ENDED',
    ]);
    // 기한이 흐르지 않는다 — 만료 · 날인 · 거부로 바로 가지 않는다
    for (const to of ['EXPIRED', 'SIGNED', 'REJECTED'] as const)
      expect(canTransition('CORRECTION_REQUESTED', to)).toBe(false);
  });

  it('저장하면 곧바로 보낸다 — 임시저장에서 서명 대기로 바로 간다(앱으로 받는 직원), 번호를 계정 없는 번호로 고치면 발송 대기', () => {
    expect(canTransition('DRAFT', 'PENDING_SIGNATURE')).toBe(true);
    expect(canTransition('PENDING_SIGNATURE', 'PENDING_SEND')).toBe(true);
    expect(canTransition('CORRECTION_REQUESTED', 'PENDING_SEND')).toBe(true);
  });

  it('requestCorrection — 서명 대기를 수정 요청으로 바꾸고 직원 이력을 남긴다', async () => {
    const d = db();
    await requestCorrection(tx(d), 7, NOW);
    expect(d.contract.updateMany).toHaveBeenCalledWith({
      where: { contractId: 7, status: 'PENDING_SIGNATURE' },
      data: { status: 'CORRECTION_REQUESTED' },
    });
    expect(d.contractStatusHistory.create).toHaveBeenCalledWith({
      data: {
        contractId: 7,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'CORRECTION_REQUESTED',
        actor: 'STAFF',
      },
    });
  });

  it.each(['PENDING_SEND', 'CORRECTION_REQUESTED', 'SIGNED'] as const)(
    'requestCorrection — %s 이면 409',
    async (status) => {
      const d = db({ status });
      await expect(requestCorrection(tx(d), 7, NOW)).rejects.toThrow(
        ConflictException,
      );
      expect(d.contract.updateMany).not.toHaveBeenCalled();
    },
  );

  it('requestCorrection — 날인 기한이 지났으면 만료 배치 전이어도 409 SIGN_DEADLINE_PASSED, 상태는 그대로', async () => {
    const d = db({ status: 'PENDING_SIGNATURE', signDeadlineAt: NOW });
    const body = await conflictOf(requestCorrection(tx(d), 7, NOW));
    expect(body).toMatchObject({
      code: 'SIGN_DEADLINE_PASSED',
      status: 'PENDING_SIGNATURE',
    });
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });
});
