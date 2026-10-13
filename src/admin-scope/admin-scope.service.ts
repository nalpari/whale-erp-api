import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 관리자가 관리하는 점포와 그 관리자의 권한 유형(공통코드 ROLE_TYPE — PM · PA · BM · BA · FM · FA). */
export interface ManageableStores {
  roleTypeCode: string;
  stores: { storeId: number; storeTypeCode: string }[];
}

/**
 * 본사 역할(BP 마스터 · BP 관리자). 가맹 점포 직원은 본사 제공 동의를 한 경우에만 개인 단위로 본다
 * (운영 정책 ATT-30, 동의 칸 `staff_members.is_hq_sharing_consented`, #137).
 */
const HQ_ROLES = new Set(['BM', 'BA']);

/**
 * 이 역할에게 이 점포 직원의 개인 정보를 가리는가. 직원 목록의 가린 행 · 개인 칸 필터와 직원 단위 API 의 거부가
 * 같은 기준을 쓴다 — 목록에서 가린 직원을 ID 로 찾아가 보거나 퇴직 처리하면 가림이 소용없다. 직영이 아니면(모르는
 * 유형 포함) 동의하지 않은 직원을 가린다. 개인정보 규칙은 판단이 틀릴 때 가리는 쪽이어야 한다. 철회하면 동의 칸이
 * false 라 다시 가려진다.
 */
export function hidesPersonalData(
  roleTypeCode: string,
  storeTypeCode: string | undefined,
  isHqSharingConsented: boolean,
): boolean {
  return (
    HQ_ROLES.has(roleTypeCode) &&
    storeTypeCode !== 'DIRECT' &&
    !isHqSharingConsented
  );
}

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

  /**
   * 이 관리자가 그 직원 레코드를 다루는가 — 점포를 관리하고, 그 직원의 개인 정보가 가려지지 않아야 한다
   * (hidesPersonalData — 본사 역할이면 직영 점포 직원이거나 본사 제공 동의한 직원). 없는 직원이면 false.
   */
  async canManageStaffMember(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<boolean> {
    const staff = await this.prisma.staffMember.findUnique({
      where: { staffMemberId },
      select: { storeId: true, isHqSharingConsented: true },
    });
    if (!staff) return false;
    const managed = await this.managedStore(adminAccountId, staff.storeId);
    return (
      managed !== null &&
      !hidesPersonalData(
        managed.roleTypeCode,
        managed.storeTypeCode,
        staff.isHqSharingConsented,
      )
    );
  }

  /**
   * 플랫폼 관리자(PM · PA)인가. 관리자 토큰은 BP · 가맹 관리자도 받고 가드는 DB 를 보지 않으므로,
   * 지우거나 사용중지 · 탈퇴한 계정도 여기서 걸러진다.
   */
  async isPlatformAdmin(adminAccountId: number): Promise<boolean> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { roleTypeCode: true },
    });
    return admin !== null && ['PM', 'PA'].includes(admin.roleTypeCode);
  }

  async canManageStore(
    adminAccountId: number,
    storeId: number,
  ): Promise<boolean> {
    return (await this.managedStore(adminAccountId, storeId)) !== null;
  }

  /** 관리하는 점포면 관리자의 권한 유형과 점포 유형, 아니면 null. */
  private async managedStore(
    adminAccountId: number,
    storeId: number,
  ): Promise<{ roleTypeCode: string; storeTypeCode: string } | null> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
    });
    if (!admin) return null;
    // 전체 점포 관리자도 자기 BP 의 점포만이다. 매핑은 BP 를 넘지 않는다는 보장이 DB 에 없어 함께 본다.
    const store = await this.prisma.store.findFirst({
      where: { storeId, bpCodeId: admin.bpCodeId, isDeleted: false },
      select: { storeTypeCode: true },
    });
    if (!store) return null;
    const managed = {
      roleTypeCode: admin.roleTypeCode,
      storeTypeCode: store.storeTypeCode,
    };
    if (admin.isAllStores) return managed;
    const mapped = await this.prisma.adminStoreMapping.count({
      where: { adminAccountId, storeId, isDeleted: false },
    });
    return mapped > 0 ? managed : null;
  }

  /**
   * 관리하는 점포 전부. canManageStore 와 같은 규칙이다 — 사용 중인 계정, 자기 BP 의 삭제되지 않은 점포,
   * 전체 점포가 아니면 삭제되지 않은 매핑의 점포만. 계정이 없거나 사용 중이 아니면 null.
   */
  async getManageableStores(
    adminAccountId: number,
  ): Promise<ManageableStores | null> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
    });
    if (!admin) return null;
    const stores = await this.prisma.store.findMany({
      where: {
        bpCodeId: admin.bpCodeId,
        isDeleted: false,
        ...(admin.isAllStores
          ? {}
          : { adminMappings: { some: { adminAccountId, isDeleted: false } } }),
      },
      select: { storeId: true, storeTypeCode: true },
      orderBy: { storeId: 'asc' },
    });
    return { roleTypeCode: admin.roleTypeCode, stores };
  }
}
