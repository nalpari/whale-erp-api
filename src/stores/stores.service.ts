import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListStoresQueryDto } from './dto/list-stores-query.dto';
import { StoreListResponseDto } from './dto/store.response.dto';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  /** 근로계약서 근무지 같은 선택지용. 지운 점포와 폐점(STORE_STATUS CLOSED)은 고를 수 없다. */
  async list({
    page,
    pageSize,
  }: ListStoresQueryDto): Promise<StoreListResponseDto> {
    const where: Prisma.StoreWhereInput = {
      isDeleted: false,
      storeStatusCode: { not: 'CLOSED' },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.store.findMany({
        where,
        select: { storeId: true, name: true },
        orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.store.count({ where }),
    ]);
    return { items, total };
  }
}
