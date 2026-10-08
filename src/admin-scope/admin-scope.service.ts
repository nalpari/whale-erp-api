import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 관리자의 관리 범위. 사용 중인 관리자 계정이 소속 BP 의 점포를 관리한다 — 전체 점포(`is_all_stores`)면
 * 그 BP 의 모든 점포, 아니면 `admin_store_mappings` 에 매핑된 점포만이다.
 *
 * 플랫폼 관리자(PM · PA)가 고객 BP 의 점포를 다루는 범위는 아직 정하지 않았다. 지금은 BP 가 같아야 하므로
 * 플랫폼 BP 소속 관리자는 고객 점포를 관리하지 못한다. 업무 범위 적용(WHALEERP-301)이 정해지면 여기서 넓힌다.
 */
@Injectable()
export class AdminScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** 그 직원 레코드의 점포를 이 관리자가 관리하는가. 없는 직원이면 false. */
  async canManageStaffMember(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<boolean> {
    const staff = await this.prisma.staffMember.findUnique({
      where: { staffMemberId },
      select: { storeId: true },
    });
    return staff !== null && this.canManageStore(adminAccountId, staff.storeId);
  }

  async canManageStore(
    adminAccountId: number,
    storeId: number,
  ): Promise<boolean> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { bpCodeId: true, isAllStores: true },
    });
    if (!admin) return false;
    // 전체 점포 관리자도 자기 BP 의 점포만이다. 매핑은 BP 를 넘지 않는다는 보장이 DB 에 없어 함께 본다.
    const inBp = await this.prisma.store.count({
      where: { storeId, bpCodeId: admin.bpCodeId, isDeleted: false },
    });
    if (inBp === 0) return false;
    if (admin.isAllStores) return true;
    const mapped = await this.prisma.adminStoreMapping.count({
      where: { adminAccountId, storeId, isDeleted: false },
    });
    return mapped > 0;
  }
}
