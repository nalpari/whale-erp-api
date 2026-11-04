// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import {
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { RetirementService } from '../staff-members/retirement.service';
import { storeClosingCheck } from '../staff-members/store-closing-check';
import { retainEndDate } from '../stores/store-format';
import {
  StoreClosingsService,
  retryOnDeadlock,
} from './store-closings.service';

jest.mock('../staff-members/store-closing-check', () => ({
  storeClosingCheck: jest.fn(),
}));

const checkMock = storeClosingCheck as jest.Mock;

/** 2026-11-04 00:30 KST = 2026-11-03 15:30Z — 한국 날짜는 11-04 */
const NOW = new Date('2026-11-03T15:30:00Z');
const TODAY = new Date('2026-11-04T00:00:00Z');

const counts = (open = 0, hidden = 0, extra: Record<string, number> = {}) => ({
  openCheckIns: {
    count: open,
    hiddenCount: hidden,
    first: open
      ? {
          storeId: 11,
          attendanceRecordId: 1,
          staffMemberId: 2,
          name: '홍길동',
          recordedAt: NOW,
          isCheckOutExpired: false,
        }
      : null,
  },
  retiringStaff: 0,
  draftContracts: 0,
  pendingSendContracts: 0,
  pendingSignatureContracts: 0,
  unconfirmedPayslips: 0,
  ...extra,
});

const retirement = (n = 0) => ({
  retiringStaff: n,
  pulledForwardStaff: 0,
  draftContracts: 0,
  pendingSendContracts: 0,
  pendingSignatureContracts: 0,
  expiredInvitations: 0,
});

describe('StoreClosingsService', () => {
  let service: StoreClosingsService;
  let retire: { retireStores: jest.Mock };
  let client: Record<string, any>;

  beforeEach(async () => {
    checkMock.mockReset();
    retire = { retireStores: jest.fn() };
    client = {
      $queryRaw: jest.fn(),
      store: {
        findMany: jest.fn().mockResolvedValue([
          { storeId: 11, name: '강남점', storeCode: 'ST000011' },
          { storeId: 12, name: '역삼점', storeCode: 'ST000012' },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      storeChangeHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        StoreClosingsService,
        { provide: RetirementService, useValue: retire },
      ],
    }).compile();
    service = module.get(StoreClosingsService);
  });

  describe('check', () => {
    it('점포별 결과에 점포명 · 점포코드를 붙이고, 한국 날짜 오늘로 3팀 확인을 부른다', async () => {
      checkMock.mockResolvedValue({
        stores: [
          { storeId: 11, ...counts(0, 0, { retiringStaff: 3 }) },
          { storeId: 12, ...counts() },
        ],
        total: counts(0, 0, { retiringStaff: 3 }),
      });

      const result = await service.check(client as any, [12, 11], NOW);

      expect(checkMock).toHaveBeenCalledWith(client, [11, 12], TODAY, NOW);
      expect(result.stores).toEqual([
        expect.objectContaining({
          storeId: 11,
          storeName: '강남점',
          storeCode: 'ST000011',
          retiringStaff: 3,
          isBlocked: false,
        }),
        expect.objectContaining({
          storeId: 12,
          storeName: '역삼점',
          storeCode: 'ST000012',
          isBlocked: false,
        }),
      ]);
      expect(result.total.retiringStaff).toBe(3);
      expect(result.isBlocked).toBe(false);
    });

    it('열린 출근은 수만 내보낸다 — 3팀 결과의 첫 건(직원 이름 · 시각)은 점포 조회 권한만으로 보이므로 뺀다', async () => {
      checkMock.mockResolvedValue({
        stores: [
          { storeId: 11, ...counts(1, 0) },
          { storeId: 12, ...counts() },
        ],
        total: counts(1, 0),
      });

      const result = await service.check(client as any, [11, 12], NOW);

      expect(result.stores[0].openCheckIns).toEqual({
        count: 1,
        hiddenCount: 0,
      });
      expect(result.total.openCheckIns).toEqual({ count: 1, hiddenCount: 0 });
      expect(JSON.stringify(result)).not.toContain('홍길동');
      expect(result.isBlocked).toBe(true);
    });

    it('가려지는 직원의 열린 출근만 있어도 막힌다 — count + hiddenCount', async () => {
      checkMock.mockResolvedValue({
        stores: [
          { storeId: 11, ...counts() },
          { storeId: 12, ...counts(0, 1) },
        ],
        total: counts(0, 1),
      });

      const result = await service.check(client as any, [11, 12], NOW);

      expect(result.stores.map((s) => s.isBlocked)).toEqual([false, true]);
      expect(result.total.isBlocked).toBe(true);
      expect(result.isBlocked).toBe(true);
    });

    it('점포명을 찾지 못하면 빈 이름으로 숨기지 않고 500', async () => {
      checkMock.mockResolvedValue({
        stores: [
          { storeId: 11, ...counts() },
          { storeId: 99, ...counts() },
        ],
        total: counts(),
      });
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      await expect(
        service.check(client as any, [11, 99], NOW),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      // HttpException 은 Nest 가 로그로 남기지 않는다 — 서버에서 원인을 찾게 직접 남긴다
      expect(error).toHaveBeenCalledWith(expect.stringContaining('점포 99'));
      error.mockRestore();
    });

    it('빈 목록이면 아무것도 묻지 않는다', async () => {
      checkMock.mockResolvedValue({ stores: [], total: counts() });
      const result = await service.check(client as any, [], NOW);
      expect(client.store.findMany).not.toHaveBeenCalled();
      expect(result.stores).toEqual([]);
      expect(result.isBlocked).toBe(false);
    });
  });

  describe('close', () => {
    const locked = (
      rows: Partial<{
        storeId: number;
        name: string;
        storeCode: string;
        storeStatusCode: string;
        isDeleted: boolean;
      }>[],
    ) =>
      client.$queryRaw.mockResolvedValue(
        rows.map((r) => ({
          storeStatusCode: 'OPERATING',
          isDeleted: false,
          ...r,
        })),
      );

    beforeEach(() => {
      locked([
        { storeId: 11, name: '강남점', storeCode: 'ST000011' },
        {
          storeId: 12,
          name: '역삼점',
          storeCode: 'ST000012',
          storeStatusCode: 'NOT_OPERATING',
        },
      ]);
      retire.retireStores.mockResolvedValue({
        byStore: { 11: retirement(2), 12: retirement(1) },
        total: retirement(3),
      });
    });

    it('점포 행을 id 오름차순으로 FOR NO KEY UPDATE 로 잠근 뒤 3팀 일괄 퇴직을 부른다', async () => {
      await service.close(client as any, [12, 11, 12], 7, NOW);

      const [strings, ids] = client.$queryRaw.mock.calls[0] as [
        string[],
        Prisma.Sql,
      ];
      const text = strings.join('');
      expect(text).toContain('ORDER BY store_id');
      expect(text).toContain('FOR NO KEY UPDATE');
      expect(ids.values).toEqual([11, 12]);
      expect(retire.retireStores).toHaveBeenCalledWith(
        client,
        [11, 12],
        TODAY,
        7,
        NOW,
      );
    });

    it('폐점 · 폐점일(한국 날짜) · 수정자를 넣고 점포마다 점포상태 이력을 남긴다', async () => {
      await service.close(client as any, [11, 12], 7, NOW);

      expect(client.store.updateMany).toHaveBeenCalledWith({
        where: { storeId: { in: [11, 12] } },
        data: { storeStatusCode: 'CLOSED', closedDate: TODAY, updatedBy: 7 },
      });
      const rows = client.storeChangeHistory.createMany.mock.calls[0][0].data;
      expect(rows).toEqual([
        {
          storeId: 11,
          field: '점포상태',
          beforeValue: '운영',
          afterValue: '폐점',
          changedBy: 7,
          changedAt: NOW,
          // 이력 조회는 보존 기한이 오늘(한국) 이후인 것만 보인다 — 틀리면 폐점 이력이 화면에서 사라진다
          retainEndDate: retainEndDate(NOW),
        },
        expect.objectContaining({
          storeId: 12,
          beforeValue: '미운영',
          afterValue: '폐점',
        }),
      ]);
    });

    it('점포별 처리 결과에 점포명 · 점포코드를 붙이고 합계를 준다', async () => {
      const result = await service.close(client as any, [11, 12], 7, NOW);

      expect(result.stores).toEqual([
        {
          storeId: 11,
          storeName: '강남점',
          storeCode: 'ST000011',
          ...retirement(2),
        },
        {
          storeId: 12,
          storeName: '역삼점',
          storeCode: 'ST000012',
          ...retirement(1),
        },
      ]);
      expect(result.total).toEqual(retirement(3));
    });

    it('3팀 퇴직이 실패하면(열린 출근 409) 그대로 던지고 점포는 바꾸지 않는다', async () => {
      const error = new ConflictException({ code: 'OPEN_CHECK_IN' });
      retire.retireStores.mockRejectedValue(error);

      await expect(service.close(client as any, [11, 12], 7, NOW)).rejects.toBe(
        error,
      );
      expect(client.store.updateMany).not.toHaveBeenCalled();
      expect(client.storeChangeHistory.createMany).not.toHaveBeenCalled();
    });

    it('잠근 뒤 보니 지운 점포가 섞이면 404 — 문구에 그 점포 id', async () => {
      locked([
        { storeId: 11, name: '강남점', storeCode: 'ST000011' },
        { storeId: 12, name: '역삼점', storeCode: 'ST000012', isDeleted: true },
      ]);
      await expect(
        service.close(client as any, [11, 12], 7, NOW),
      ).rejects.toThrow(new NotFoundException('점포를 찾을 수 없습니다. (12)'));
      expect(retire.retireStores).not.toHaveBeenCalled();
    });

    it('잠근 뒤 보니 행이 없는 점포가 섞이면 404 — 문구에 그 점포 id', async () => {
      locked([{ storeId: 11, name: '강남점', storeCode: 'ST000011' }]);
      await expect(
        service.close(client as any, [11, 12, 13], 7, NOW),
      ).rejects.toThrow(
        new NotFoundException('점포를 찾을 수 없습니다. (12, 13)'),
      );
      expect(retire.retireStores).not.toHaveBeenCalled();
    });

    it('잠근 뒤 보니 이미 폐점한 점포가 섞이면 409', async () => {
      locked([
        { storeId: 11, name: '강남점', storeCode: 'ST000011' },
        {
          storeId: 12,
          name: '역삼점',
          storeCode: 'ST000012',
          storeStatusCode: 'CLOSED',
        },
      ]);
      await expect(
        service.close(client as any, [11, 12], 7, NOW),
      ).rejects.toThrow(new ConflictException('이미 폐점한 점포입니다. (12)'));
      expect(retire.retireStores).not.toHaveBeenCalled();
    });

    it('3팀 결과에 점포가 빠지면 「처리 0건」으로 숨기지 않고 500', async () => {
      retire.retireStores.mockResolvedValue({
        byStore: { 11: retirement(2) },
        total: retirement(2),
      });
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      await expect(
        service.close(client as any, [11, 12], 7, NOW),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('점포 12'));
      error.mockRestore();
    });

    it('빈 목록이면 아무것도 잠그거나 쓰지 않는다', async () => {
      const result = await service.close(client as any, [], 7, NOW);
      expect(client.$queryRaw).not.toHaveBeenCalled();
      expect(retire.retireStores).not.toHaveBeenCalled();
      expect(result).toEqual({ stores: [], total: retirement(0) });
    });
  });
});

describe('retryOnDeadlock', () => {
  const deadlock = () =>
    new Prisma.PrismaClientKnownRequestError('deadlock detected', {
      code: 'P2034',
      clientVersion: 'test',
    });
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('교착이면 경고를 남기고 한 번 다시 한다', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce('ok');
    await expect(retryOnDeadlock(run, '점포 11')).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('점포 11');
  });

  it('원시 쿼리(P2010)의 40P01 도 교착으로 본다', async () => {
    const raw = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `40P01`. Message: `deadlock detected`',
      { code: 'P2010', clientVersion: 'test' },
    );
    const run = jest.fn().mockRejectedValueOnce(raw).mockResolvedValue('ok');
    await expect(retryOnDeadlock(run, '점포 11')).resolves.toBe('ok');
  });

  it('P2010 이라도 다른 SQLSTATE 면 다시 하지 않는다', async () => {
    const raw = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `23505`. Message: `duplicate key`',
      { code: 'P2010', clientVersion: 'test' },
    );
    const run = jest.fn().mockRejectedValue(raw);
    await expect(retryOnDeadlock(run, '점포 11')).rejects.toBe(raw);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('두 번째도 교착이면 500 이 아니라 409 「바뀐 것 없음 · 다시 시도」', async () => {
    const run = jest.fn().mockRejectedValue(deadlock());
    await expect(retryOnDeadlock(run, '점포 11')).rejects.toThrow(
      new ConflictException(
        '다른 처리와 겹쳐 폐점하지 못했습니다. 바뀐 것은 없으니 잠시 뒤 다시 시도해 주세요.',
      ),
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('두 번째 교착이 원시 쿼리(P2010)여도 409 이고, 경고는 두 번 모두 대상을 남긴다', async () => {
    const raw = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `40P01`. Message: `deadlock detected`',
      { code: 'P2010', clientVersion: 'test' },
    );
    const run = jest
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockRejectedValueOnce(raw);
    await expect(retryOnDeadlock(run, '점포 11')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('점포 11');
  });

  it('다시 한 쪽이 교착이 아닌 오류면 그 오류를 그대로 던진다', async () => {
    const error = new ConflictException({ code: 'OPEN_CHECK_IN' });
    const run = jest
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockRejectedValueOnce(error);
    await expect(retryOnDeadlock(run, '점포 11')).rejects.toBe(error);
  });

  it('교착이 아닌 오류는 다시 하지 않는다', async () => {
    const error = new ConflictException('x');
    const run = jest.fn().mockRejectedValue(error);
    await expect(retryOnDeadlock(run, '점포 11')).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
