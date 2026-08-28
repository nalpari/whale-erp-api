import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ItemResponseDto, MovementResponseDto } from './dto/item.response.dto';
import { ListItemsQueryDto } from './dto/list-items-query.dto';
import { UpdateItemDto } from './dto/update-item.dto';

interface ItemRow {
  id: number;
  sku: string;
  name: string;
  unit: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  private toResponse(item: ItemRow, stock: number): ItemResponseDto {
    return {
      id: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      stock,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  // 라우트 파라미터는 문자열이다. int 범위를 벗어난 값을 그대로 넘기면
  // Postgres 가 에러를 내 500 이 되므로, 여기서 걸러 404 로 응답한다.
  private toId(id: string): number {
    const INT_MAX = 2147483647;
    if (!/^\d+$/.test(id) || Number(id) > INT_MAX)
      throw new NotFoundException(`품목 ${id} 을(를) 찾을 수 없습니다`);
    return Number(id);
  }

  private static readonly DEFAULT_TAKE = 50;

  async findAll(query: ListItemsQueryDto): Promise<ItemResponseDto[]> {
    const take = query.take ?? ItemsService.DEFAULT_TAKE;
    const skip = query.skip ?? 0;
    const items = await this.prisma.item.findMany({
      orderBy: { id: 'asc' },
      take,
      skip,
    });
    if (items.length === 0) return [];

    // 품목마다 집계를 돌리면 N+1 이 된다. 그렇다고 where 를 빼면 반환하지도
    // 않을 품목의 이력까지 전부 스캔하므로, 이번 페이지로만 한정해 읽는다.
    const ids = items.map((i) => i.id);
    const sums = await this.prisma.stockMovement.groupBy({
      by: ['itemId'],
      _sum: { quantity: true },
      where: { itemId: { in: ids } },
    });
    const byItem = new Map(sums.map((s) => [s.itemId, s._sum.quantity ?? 0]));
    return items.map((i) => this.toResponse(i, byItem.get(i.id) ?? 0));
  }

  async findOne(id: string): Promise<ItemResponseDto> {
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

  async create(dto: CreateItemDto): Promise<ItemResponseDto> {
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

  async update(id: string, dto: UpdateItemDto): Promise<ItemResponseDto> {
    const itemId = this.toId(id);
    // 빈 본문은 아무것도 바꾸지 않으면서 @updatedAt 만 움직인다.
    // 갱신 시각이 거짓말을 하게 두느니 거절한다.
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('변경할 필드가 없습니다');
    }
    let item: ItemRow;
    try {
      item = await this.prisma.item.update({
        where: { id: itemId },
        data: dto,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2025')
        throw new NotFoundException(`품목 ${id} 을(를) 찾을 수 없습니다`);
      if (code === 'P2002')
        throw new ConflictException(`sku '${dto.sku}' 는 이미 존재합니다`);
      throw e;
    }
    const agg = await this.prisma.stockMovement.aggregate({
      _sum: { quantity: true },
      where: { itemId },
    });
    return this.toResponse(item, agg._sum.quantity ?? 0);
  }

  async remove(id: string): Promise<void> {
    const itemId = this.toId(id);
    try {
      await this.prisma.item.delete({ where: { id: itemId } });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2025')
        throw new NotFoundException(`품목 ${id} 을(를) 찾을 수 없습니다`);
      // FK 가 ON DELETE RESTRICT 다. 이력이 남은 품목은 지울 수 없다.
      // 재고 이력을 지우는 건 회계상 흔적을 지우는 일이라 API 로 열지 않는다.
      if (code === 'P2003')
        throw new ConflictException(
          `품목 ${id} 에 입출고 이력이 있어 삭제할 수 없습니다`,
        );
      throw e;
    }
  }

  async addMovement(
    itemId: string,
    dto: CreateStockMovementDto,
  ): Promise<MovementResponseDto> {
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
        id: movement.id,
        itemId: id,
        quantity: dto.quantity,
        reason: dto.reason,
        stock: next,
        createdAt: movement.createdAt,
      };
    });
  }
}
