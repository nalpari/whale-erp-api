import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';

export interface ItemResponse {
  id: string;
  sku: string;
  name: string;
  unit: string;
  stock: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementResponse {
  id: string;
  itemId: string;
  quantity: number;
  reason: string;
  stock: number;
  createdAt: Date;
}

interface ItemRow {
  id: bigint;
  sku: string;
  name: string;
  unit: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  // bigint 컬럼은 JSON 으로 직렬화되지 않는다. 경계에서 문자열로 바꾼다.
  private toResponse(item: ItemRow, stock: number): ItemResponse {
    return {
      id: item.id.toString(),
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      stock,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private toId(id: string): bigint {
    if (!/^\d+$/.test(id))
      throw new NotFoundException(`품목 ${id} 을(를) 찾을 수 없습니다`);
    return BigInt(id);
  }

  async findAll(): Promise<ItemResponse[]> {
    const items = await this.prisma.item.findMany({ orderBy: { id: 'asc' } });
    // 품목마다 집계 쿼리를 돌리면 N+1 이 되므로 한 번에 묶어 읽는다.
    const sums = await this.prisma.stockMovement.groupBy({
      by: ['itemId'],
      _sum: { quantity: true },
    });
    const byItem = new Map(
      sums.map((s) => [s.itemId.toString(), s._sum.quantity ?? 0]),
    );
    return items.map((i) =>
      this.toResponse(i, byItem.get(i.id.toString()) ?? 0),
    );
  }

  async findOne(id: string): Promise<ItemResponse> {
    const item = await this.prisma.item.findUnique({
      where: { id: this.toId(id) },
    });
    if (!item)
      throw new NotFoundException(`품목 ${id} 을(를) 찾을 수 없습니다`);
    const agg = await this.prisma.stockMovement.aggregate({
      _sum: { quantity: true },
      where: { itemId: item.id },
    });
    return this.toResponse(item, agg._sum.quantity ?? 0);
  }

  async create(dto: CreateItemDto): Promise<ItemResponse> {
    try {
      const item = await this.prisma.item.create({
        data: { sku: dto.sku, name: dto.name, unit: dto.unit ?? 'EA' },
      });
      return this.toResponse(item, 0);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException(`sku '${dto.sku}' 는 이미 존재합니다`);
      }
      throw e;
    }
  }

  async addMovement(
    itemId: string,
    dto: CreateStockMovementDto,
  ): Promise<MovementResponse> {
    const id = this.toId(itemId);
    return this.prisma.$transaction(async (tx) => {
      // 행 잠금이 없으면 두 출고가 같은 재고를 읽고 둘 다 통과해 음수가 된다.
      // 잠금은 트랜잭션이 끝날 때까지 유지된다.
      await tx.$queryRaw`SELECT id FROM items WHERE id = ${id} FOR UPDATE`;

      const item = await tx.item.findUnique({ where: { id } });
      if (!item)
        throw new NotFoundException(`품목 ${itemId} 을(를) 찾을 수 없습니다`);

      const agg = await tx.stockMovement.aggregate({
        _sum: { quantity: true },
        where: { itemId: id },
      });
      const current = agg._sum.quantity ?? 0;
      const next = current + dto.quantity;
      if (next < 0) {
        throw new BadRequestException(
          `재고가 부족합니다: 현재 ${current}, 요청 ${dto.quantity}`,
        );
      }

      const movement = await tx.stockMovement.create({
        data: { itemId: id, quantity: dto.quantity, reason: dto.reason },
      });
      return {
        id: movement.id.toString(),
        itemId: itemId,
        quantity: dto.quantity,
        reason: dto.reason,
        stock: next,
        createdAt: movement.createdAt ?? new Date(),
      };
    });
  }
}
