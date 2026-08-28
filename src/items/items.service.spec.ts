import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { ItemsService } from './items.service';

type Tx = {
  item: { findUnique: jest.Mock };
  stockMovement: { aggregate: jest.Mock; create: jest.Mock };
  $queryRaw: jest.Mock;
};

describe('ItemsService', () => {
  let service: ItemsService;
  let prisma: {
    item: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
    stockMovement: { aggregate: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: Tx;

  beforeEach(async () => {
    tx = {
      item: { findUnique: jest.fn() },
      stockMovement: { aggregate: jest.fn(), create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1n }]),
    };
    prisma = {
      item: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
      stockMovement: { aggregate: jest.fn() },
      $transaction: jest.fn((cb: (t: Tx) => unknown) => cb(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ItemsService);
  });

  describe('findOne', () => {
    it('없는 id 면 NotFoundException', async () => {
      prisma.item.findUnique.mockResolvedValue(null);
      await expect(service.findOne('999')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('bigint id 를 문자열로 돌려준다 (JSON 직렬화 불가 방지)', async () => {
      prisma.item.findUnique.mockResolvedValue({
        id: 9007199254740993n, // Number.MAX_SAFE_INTEGER 초과
        sku: 'A',
        name: '가',
        unit: 'EA',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
      prisma.stockMovement.aggregate.mockResolvedValue({
        _sum: { quantity: 3 },
      });
      const r = await service.findOne('9007199254740993');
      expect(r.id).toBe('9007199254740993');
      expect(() => JSON.stringify(r)).not.toThrow();
    });
  });

  describe('create', () => {
    it('sku 중복(P2002)이면 ConflictException', async () => {
      prisma.item.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.create({ sku: 'DUP', name: '중복' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('addMovement — 재고는 음수가 될 수 없다', () => {
    beforeEach(() => {
      tx.item.findUnique.mockResolvedValue({
        id: 1n,
        sku: 'A',
        name: '가',
        unit: 'EA',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
      tx.stockMovement.create.mockResolvedValue({ id: 10n, quantity: 0 });
    });

    it('출고량이 현재 재고보다 크면 거부하고 아무것도 쓰지 않는다', async () => {
      tx.stockMovement.aggregate.mockResolvedValue({ _sum: { quantity: 5 } });
      await expect(
        service.addMovement('1', { quantity: -6, reason: '출고' }),
      ).rejects.toThrow(/재고/);
      expect(tx.stockMovement.create).not.toHaveBeenCalled();
    });

    it('현재 재고와 같은 수량 출고는 허용한다 (0 이 됨)', async () => {
      tx.stockMovement.aggregate.mockResolvedValue({ _sum: { quantity: 5 } });
      await expect(
        service.addMovement('1', { quantity: -5, reason: '출고' }),
      ).resolves.toMatchObject({ stock: 0 });
    });

    it('이력이 없어 합계가 null 인 품목의 출고는 거부한다', async () => {
      tx.stockMovement.aggregate.mockResolvedValue({
        _sum: { quantity: null },
      });
      await expect(
        service.addMovement('1', { quantity: -1, reason: '출고' }),
      ).rejects.toThrow(/재고/);
    });

    it('입고는 현재 재고와 무관하게 허용한다', async () => {
      tx.stockMovement.aggregate.mockResolvedValue({
        _sum: { quantity: null },
      });
      await expect(
        service.addMovement('1', { quantity: 7, reason: '입고' }),
      ).resolves.toMatchObject({ stock: 7 });
    });

    it('동시 초과출고를 막기 위해 품목 행을 잠근다', async () => {
      tx.stockMovement.aggregate.mockResolvedValue({ _sum: { quantity: 5 } });
      await service.addMovement('1', { quantity: -1, reason: '출고' });
      expect(tx.$queryRaw).toHaveBeenCalled();
    });

    it('없는 품목이면 NotFoundException', async () => {
      tx.item.findUnique.mockResolvedValue(null);
      await expect(
        service.addMovement('999', { quantity: 1, reason: '입고' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
