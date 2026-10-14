import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/** 관리자가 관리하는 점포와 그 관리자의 권한 유형(공통코드 ROLE_TYPE — PM · PA · BM · BA · FM · FA). */
export interface ManageableStores {
  roleTypeCode: string;
  stores: { storeId: number; storeTypeCode: string }[];
}

/**
 * 본사 역할(BP 마스터 · BP 관리자). 가맹 점포 직원은 본사 제공 동의를 한 경우에만 개인 단위로 본다
 * (운영 정책 ATT-30). 동의 칸(hq_sharing_consent)이 아직 없어 지금은 모두 동의 없음이다 — 칸이 생기면
 * hidesPersonalData 에 「동의했으면 가리지 않는다」를 더한다(WHALEERP-137).
 */
const HQ_ROLES = new Set(['BM', 'BA']);

/**
 * 이 역할에게 이 점포의 직원 개인 정보를 가리는가. 직원 목록의 가린 행과 직원 단위 API 의 거부가 같은 기준을
 * 쓴다 — 목록에서 가린 직원을 ID 로 찾아가 보거나 퇴직 처리하면 가림이 소용없다. 직영이 아니면(모르는 유형 포함)
 * 가린다. 개인정보 규칙은 판단이 틀릴 때 가리는 쪽이어야 한다.
 */
export function hidesPersonalData(
  roleTypeCode: string,
  storeTypeCode: string | undefined,
): boolean {
  return HQ_ROLES.has(roleTypeCode) && storeTypeCode !== 'DIRECT';
}

const STORE_SELECT = {
  storeId: true,
  storeCode: true,
  name: true,
  storeTypeCode: true,
  storeStatusCode: true,
} as const;
const STORE_ORDER = [{ name: 'asc' as const }, { storeId: 'asc' as const }];

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
   * 이 관리자가 그 직원 레코드를 다루는가 — 점포를 관리하고, 그 점포의 직원 개인 정보가 가려지지 않아야 한다.
   * 없는 직원이면 false.
   */
  async canManageStaffMember(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<boolean> {
    const staff = await this.prisma.staffMember.findUnique({
      where: { staffMemberId },
      select: { storeId: true },
    });
    if (!staff) return false;
    return this.canManageStaffAt(adminAccountId, staff.storeId);
  }

  /**
   * 이 관리자가 그 점포의 직원 개인 정보를 다루는가 — 점포를 관리하고, 가려지지 않아야 한다. 근로계약처럼
   * 직원 레코드보다 점포가 먼저인 곳(작성할 근무지)이 쓴다.
   */
  async canManageStaffAt(
    adminAccountId: number,
    storeId: number,
  ): Promise<boolean> {
    const managed = await this.managedStore(adminAccountId, storeId);
    return (
      managed !== null &&
      !hidesPersonalData(managed.roleTypeCode, managed.storeTypeCode)
    );
  }

  /**
   * 사용 중인 플랫폼 관리자(플랫폼 BP 의 PM · PA)인가. 관리자 토큰은 BP · 가맹 관리자도 받는다. 가드는 세션만
   * 보고 계정 상태는 보지 않으므로(미사용 · 탈퇴는 갱신에서 끊긴다, 최대 1시간), 사용 중이 아닌 계정은 여기서
   * 거른다. 역할이 고객 BP 계정에 잘못 붙어도 통과하지 않게 플랫폼 BP 소속까지 본다.
   */
  async isPlatformAdmin(adminAccountId: number): Promise<boolean> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: {
        adminAccountId,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
        roleTypeCode: { in: ['PM', 'PA'] },
        bpCode: { isPlatform: true },
      },
      select: { adminAccountId: true },
    });
    return admin !== null;
  }

  /**
   * 이 관리자가 관리하는 점포 목록. `canManageStore` 와 같은 규칙이다 — 사용 중 계정, 소속 BP 의 미삭제 점포,
   * 전체 점포가 아니면 매핑된 점포만. 관리자 웹 로그인 정보의 점포 선택지가 쓴다.
   */
  async listStores(adminAccountId: number) {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { bpCodeId: true, isAllStores: true },
    });
    if (!admin) return [];
    return this.prisma.store.findMany({
      where: {
        bpCodeId: admin.bpCodeId,
        isDeleted: false,
        ...(admin.isAllStores
          ? {}
          : { adminMappings: { some: { adminAccountId, isDeleted: false } } }),
      },
      select: STORE_SELECT,
      orderBy: STORE_ORDER,
    });
  }

  /**
   * 그 BP 의 점포 목록을 볼 수 있는가(2026-10-14 재영). 플랫폼 BP 의 PM · PA 는 어느 BP 든, BP · 가맹 관리자는
   * 자기 BP 만, 직원 앱은 가입 · 재직 중인 직원 레코드의 점포가 그 BP 에 있을 때만이다. 사용 중인 관리자 계정이
   * 아니면 unavailable — 가드가 계정 상태를 보지 않아 여기서 거른다. 다른 BP 는 denied(부르는 쪽이 404 로 답해
   * 그 BP 가 있는지도 드러내지 않는다).
   */
  async bpStoresAccess(
    user: AuthUser,
    bpCodeId: number,
  ): Promise<'allowed' | 'denied' | 'unavailable'> {
    if (user.type === 'admin') {
      const admin = await this.prisma.adminAccount.findFirst({
        where: {
          adminAccountId: user.id,
          isDeleted: false,
          accountStatusCode: 'ACTIVE',
        },
        select: {
          bpCodeId: true,
          roleTypeCode: true,
          bpCode: { select: { isPlatform: true } },
        },
      });
      if (!admin) return 'unavailable';
      const isPlatformAdmin =
        admin.bpCode.isPlatform && ['PM', 'PA'].includes(admin.roleTypeCode);
      return isPlatformAdmin || admin.bpCodeId === bpCodeId
        ? 'allowed'
        : 'denied';
    }
    // 직원 레코드와 점포는 팀 경계라 관계가 없다 — 점포 id 로 두 번 묻는다.
    const memberships = await this.prisma.staffMember.findMany({
      where: {
        accountId: user.id,
        joinStatus: 'JOINED',
        employmentStatus: 'EMPLOYED',
      },
      select: { storeId: true },
    });
    if (memberships.length === 0) return 'denied';
    const inBp = await this.prisma.store.count({
      where: {
        storeId: { in: memberships.map((m) => m.storeId) },
        bpCodeId,
        isDeleted: false,
      },
    });
    return inBp > 0 ? 'allowed' : 'denied';
  }

  /**
   * 고객 BP 의 미삭제 점포 전체(운영 상태와 상관없이). 없거나 삭제된 BP · 플랫폼 BP 면 null.
   * 탈퇴한 BP 도 기록을 봐야 하므로 막지 않는다. 누가 불러도 되는지는 부르는 쪽이 정한다.
   */
  async listBpStores(bpCodeId: number) {
    const bp = await this.prisma.bpCode.findFirst({
      where: { bpCodeId, isDeleted: false, isPlatform: false },
      select: { bpCodeId: true },
    });
    if (!bp) return null;
    return this.prisma.store.findMany({
      where: { bpCodeId, isDeleted: false },
      select: STORE_SELECT,
      orderBy: STORE_ORDER,
    });
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
