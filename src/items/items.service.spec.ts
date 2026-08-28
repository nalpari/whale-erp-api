import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
    item: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    stockMovement: { aggregate: jest.Mock; groupBy: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: Tx;

  beforeEach(async () => {
    tx = {
      item: { findUnique: jest.fn() },
      stockMovement: { aggregate: jest.fn(), create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    };
    prisma = {
      item: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      stockMovement: { aggregate: jest.fn(), groupBy: jest.fn() },
      $transaction: jest.fn((cb: (t: Tx) => unknown) => cb(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ItemsService);
  });

  describe('findAll', () => {
    const rows = [
      {
        id: 1,
        sku: 'A',
        name: '가',
        unit: 'EA',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: 2,
        sku: 'B',
        name: '나',
        unit: 'EA',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];

    it('재고 합계를 품목에 올바로 매칭한다', async () => {
      prisma.item.findMany.mockResolvedValue(rows);
      prisma.stockMovement.groupBy.mockResolvedValue([
        { itemId: 2, _sum: { quantity: 7 } },
      ]);
      const r = await service.findAll({});
      expect(r.map((x) => [x.id, x.stock])).toEqual([
        [1, 0], // 이력이 없는 품목은 0
        [2, 7],
      ]);
    });

    it('이력 합계가 null 이어도 0 으로 채운다', async () => {
      prisma.item.findMany.mockResolvedValue([rows[0]]);
      prisma.stockMovement.groupBy.mockResolvedValue([
        { itemId: 1, _sum: { quantity: null } },
      ]);
      expect((await service.findAll({}))[0].stock).toBe(0);
    });

    it('기본 상한 50 을 적용한다', async () => {
      prisma.item.findMany.mockResolvedValue([]);
      prisma.stockMovement.groupBy.mockResolvedValue([]);
      await service.findAll({});
      expect(prisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 0 }),
      );
    });

    it('take/skip 을 그대로 넘긴다', async () => {
      prisma.item.findMany.mockResolvedValue([]);
      prisma.stockMovement.groupBy.mockResolvedValue([]);
      await service.findAll({ take: 10, skip: 20 });
      expect(prisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 20 }),
      );
    });

    // 집계에 where 가 없으면 반환하지 않는 품목의 이력까지 전부 스캔한다.
    it('집계를 조회한 품목으로만 한정한다', async () => {
      prisma.item.findMany.mockResolvedValue(rows);
      prisma.stockMovement.groupBy.mockResolvedValue([]);
      await service.findAll({});
      expect(prisma.stockMovement.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { itemId: { in: [1, 2] } } }),
      );
    });

    it('품목이 없으면 집계를 아예 조회하지 않는다', async () => {
      prisma.item.findMany.mockResolvedValue([]);
      await service.findAll({});
      expect(prisma.stockMovement.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('없는 id 면 NotFoundException', async () => {
      prisma.item.findUnique.mockResolvedValue(null);
      await expect(service.findOne('999')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('id 를 number 로 돌려주고 직렬화된다', async () => {
      prisma.item.findUnique.mockResolvedValue({
        id: 7,
        sku: 'A',
        name: '가',
        unit: 'EA',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
      prisma.stockMovement.aggregate.mockResolvedValue({
        _sum: { quantity: 3 },
      });
      const r = await service.findOne('7');
      expect(r.id).toBe(7);
      expect(() => JSON.stringify(r)).not.toThrow();
    });

    it('int 범위를 넘는 id 는 DB 에 보내지 않고 404 로 막는다', async () => {
      // 2147483647 = int 최대값. 그대로 넘기면 Postgres 가 에러를 내 500 이 된다.
      await expect(service.findOne('2147483648')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.item.findUnique).not.toHaveBeenCalled();
    });

    it('숫자가 아닌 id 도 404', async () => {
      await expect(service.findOne('abc')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.item.findUnique).not.toHaveBeenCalled();
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

  describe('update', () => {
    it('없는 품목이면 NotFoundException', async () => {
      prisma.item.update.mockRejectedValue({ code: 'P2025' });
      await expect(
        service.update('9', { name: '새이름' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sku 중복이면 ConflictException', async () => {
      prisma.item.update.mockRejectedValue({ code: 'P2002' });
      await expect(service.update('1', { sku: 'DUP' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('빈 본문은 거부한다 (의미 없는 갱신으로 updatedAt 만 움직인다)', async () => {
      await expect(service.update('1', {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.item.update).not.toHaveBeenCalled();
    });

    it('int 범위를 넘는 id 는 DB 에 보내지 않는다', async () => {
      await expect(
        service.update('2147483648', { name: '가' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.item.update).not.toHaveBeenCalled();
    });

    it('갱신 후 현재 재고를 함께 돌려준다', async () => {
      prisma.item.update.mockResolvedValue({
        id: 1,
        sku: 'A',
        name: '새이름',
        unit: 'EA',
        createdAt: new Date(0),
        updatedAt: new Date(1),
      });
      prisma.stockMovement.aggregate.mockResolvedValue({
        _sum: { quantity: 4 },
      });
      await expect(
        service.update('1', { name: '새이름' }),
      ).resolves.toMatchObject({
        id: 1,
        name: '새이름',
        stock: 4,
      });
    });
  });

  describe('remove', () => {
    it('없는 품목이면 NotFoundException', async () => {
      prisma.item.delete.mockRejectedValue({ code: 'P2025' });
      await expect(service.remove('9')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // FK 가 ON DELETE RESTRICT 다. 이력이 있으면 Postgres 가 23503 을 내고
    // Prisma 가 P2003 으로 넘긴다. 이걸 500 으로 흘리면 안 된다.
    it('입출고 이력이 있으면 ConflictException', async () => {
      prisma.item.delete.mockRejectedValue({ code: 'P2003' });
      await expect(service.remove('1')).rejects.toThrow(/이력/);
      await expect(service.remove('1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('이력이 없으면 삭제한다', async () => {
      prisma.item.delete.mockResolvedValue({ id: 2 });
      await expect(service.remove('2')).resolves.toBeUndefined();
      expect(prisma.item.delete).toHaveBeenCalledWith({ where: { id: 2 } });
    });

    it('int 범위를 넘는 id 는 DB 에 보내지 않는다', async () => {
      await expect(service.remove('2147483648')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.item.delete).not.toHaveBeenCalled();
    });
  });

  describe('addMovement — 재고는 음수가 될 수 없다', () => {
    beforeEach(() => {
      tx.item.findUnique.mockResolvedValue({
        id: 1,
        sku: 'A',
        name: '가',
        unit: 'EA',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
      tx.stockMovement.create.mockResolvedValue({
        id: 10,
        itemId: 1,
        quantity: 0,
        reason: '출고',
        createdAt: new Date(0),
      });
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
