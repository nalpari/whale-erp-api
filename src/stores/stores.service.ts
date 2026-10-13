import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListStoresQueryDto } from './dto/list-stores-query.dto';
import { StoreListResponseDto } from './dto/store.response.dto';

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /**
   * 근로계약서 근무지 같은 선택지용. 지운 점포와 폐점(STORE_STATUS CLOSED)은 고를 수 없다. 업무 범위 안에서
   * 직원 개인 정보를 다루는 점포만이다 — 본사 역할(BM · BA)에게 직영이 아닌 점포는 빠진다(새 근로계약과 같은 점포 단위 기준).
   * 사용 중인 관리자 계정이 아니면 403.
   */
  async list(
    adminAccountId: number,
    { page, pageSize }: ListStoresQueryDto,
  ): Promise<StoreListResponseDto> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable)
      throw new ForbiddenException('사용 중인 관리자 계정이 아닙니다');
    const storeIds = manageable.stores
      .filter(
        // 근무지 선택지라 직원이 아직 없다 — 동의 없음으로 점포 단위 판단(새 근로계약과 같다).
        (s) =>
          !hidesPersonalData(manageable.roleTypeCode, s.storeTypeCode, false),
      )
      .map((s) => s.storeId);
    const where: Prisma.StoreWhereInput = {
      storeId: { in: storeIds },
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
