import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma } from '@prisma/client';
import {
  canTransition,
  rejectContract,
  signContract,
  transition,
  transitionMany,
  TRANSITIONS,
} from './contract-status';

// 계약 하나 — 잠근 뒤 읽는 값. 기본은 날인 기한이 남은 서명 대기다.
const db = (
  row: {
    status: ContractStatus | null;
    signDeadlineAt?: Date | null;
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
      createMany: jest.fn(track('histories', {})),
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
  it('거부 · 만료 · 종료는 끝 상태다 (재발송은 WHALEERP-153 에서 정한다)', () => {
    for (const s of ['REJECTED', 'EXPIRED', 'ENDED'] as const)
      expect(TRANSITIONS[s]).toEqual([]);
  });

  it('체결 완료는 종료로만 간다 — 내용을 바꾸려면 새 계약으로 대체한다', () => {
    expect(TRANSITIONS.SIGNED).toEqual(['ENDED']);
  });

  it('날인 · 거부 · 만료는 서명 대기에서만 간다', () => {
    const statuses = Object.keys(TRANSITIONS) as ContractStatus[];
    for (const to of ['SIGNED', 'REJECTED', 'EXPIRED'] as const)
      expect(statuses.filter((s) => canTransition(s, to))).toEqual([
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
    expect(d.contractStatusHistory.createMany).toHaveBeenCalledWith({
      data: [1, 2].map((contractId) => ({
        contractId,
        fromStatus: 'PENDING_SIGNATURE',
        toStatus: 'EXPIRED',
        actor: 'SYSTEM',
      })),
    });
  });

  it('바뀐 계약이 없으면 이력을 쓰지 않는다', async () => {
    const d = db();
    d.contract.updateManyAndReturn.mockResolvedValue([]);
    await expect(
      transitionMany(tx(d), {}, 'PENDING_SIGNATURE', 'EXPIRED', 'SYSTEM'),
    ).resolves.toEqual([]);
    expect(d.contractStatusHistory.createMany).not.toHaveBeenCalled();
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

  it('이미 체결 완료면 처리하지 않고 지금 상태를 알린다', async () => {
    const d = db({ status: 'SIGNED' });
    const body = await conflictOf(signContract(tx(d), 7, now));
    expect(body).toMatchObject({
      code: 'CONTRACT_STATUS_CONFLICT',
      status: 'SIGNED',
    });
    expect(d.contract.updateMany).not.toHaveBeenCalled();
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

  it.each([
    ['비었으면', '   '],
    ['500자를 넘으면', 'x'.repeat(501)],
  ])('거부 사유가 %s 400 — 잠그지도 않는다', async (_, reason) => {
    const d = db();
    await expect(rejectContract(tx(d), 7, reason)).rejects.toThrow(
      BadRequestException,
    );
    expect(d.$executeRaw).not.toHaveBeenCalled();
  });

  it('이미 체결 완료면 거부할 수 없다', async () => {
    const d = db({ status: 'SIGNED' });
    await conflictOf(rejectContract(tx(d), 7, '사유'));
    expect(d.contract.updateMany).not.toHaveBeenCalled();
  });
});
