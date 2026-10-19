import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { containsText } from '../common/contains-text';
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
   * 이 관리자가 그 직원 레코드를 다루는가 — 점포를 관리하고, 그 직원의 개인 정보가 가려지지 않아야 한다
   * (hidesPersonalData — 본사 역할이면 직영 점포 직원이거나 본사 제공 동의한 직원). 없거나 관리 범위 밖 직원이면
   * false. 범위를 먼저 정하고 찾는다(staffInScope).
   */
  async canManageStaffMember(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<boolean> {
    const found = await this.staffInScope(adminAccountId, staffMemberId);
    return (
      found !== null &&
      !hidesPersonalData(
        found.roleTypeCode,
        found.storeTypeCode,
        found.isHqSharingConsented,
      )
    );
  }

  /**
   * 이 관리자가 그 직원의 계정에 조치(비밀번호 재설정 링크)할 수 있는가 — 본사 제공 동의와 상관없이 점포 단위로
   * 판단한다. 동의는 자료를 보는 데 대한 것이라 계정 조치로 넓히지 않는다 — 가맹 점포 직원은 가맹마스터 · 가맹관리자만
   * 된다(2026-10-14 재영, api #21, 운영 정책 ATT-30). 없거나 관리 범위 밖 직원이면 false.
   *
   * 범위를 먼저 정하고 찾는다(staffInScope).
   */
  async canManageStaffAccount(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<boolean> {
    const found = await this.staffInScope(adminAccountId, staffMemberId);
    return (
      found !== null &&
      !hidesPersonalData(found.roleTypeCode, found.storeTypeCode, false)
    );
  }

  /**
   * 관리 범위 안의 그 직원과 판정에 쓸 값. 관리 범위를 먼저 정하고 그 점포 안에서만 찾는다 — 직원을 먼저 찾고 그
   * 점포를 관리하는지 보면, 다른 BP 직원 ID 는 없는 ID 보다 쿼리가 더 돌아 같은 404 라도 응답 시간으로 그 ID 의
   * 직원이 있는지 드러난다(api #56 리뷰). 없는 직원 · 다른 BP 직원 · 범위 안 직원이 모두 같은 쿼리 셋을 거친다. 직원
   * 상세(StaffMemberListService.findOne)와 같은 방식이다. 사용 중인 관리자가 아니거나 범위 밖이면 null.
   */
  private async staffInScope(adminAccountId: number, staffMemberId: number) {
    const manageable = await this.getManageableStores(adminAccountId);
    if (!manageable) return null;
    const staff = await this.prisma.staffMember.findFirst({
      where: {
        staffMemberId,
        storeId: { in: manageable.stores.map((s) => s.storeId) },
      },
      select: { storeId: true, isHqSharingConsented: true },
    });
    if (!staff) return null;
    return {
      roleTypeCode: manageable.roleTypeCode,
      storeTypeCode: manageable.stores.find((s) => s.storeId === staff.storeId)
        ?.storeTypeCode,
      isHqSharingConsented: staff.isHqSharingConsented,
    };
  }

  /**
   * 이 관리자가 그 점포 직원의 개인 정보를 다루는가 — 점포를 관리하고, 가려지지 않아야 한다. 직원이 정해졌으면 그
   * 직원의 본사 제공 동의를 넘기고, 직원이 아직 없으면(새 근로계약의 근무지) false 를 넘긴다 — 동의할 사람이 없으니
   * 점포 단위로 판단한다(2026-10-13 재영, api #21 리뷰).
   */
  async canManageStaffAt(
    adminAccountId: number,
    storeId: number,
    isHqSharingConsented: boolean,
  ): Promise<boolean> {
    const managed = await this.managedStore(adminAccountId, storeId);
    return (
      managed !== null &&
      !hidesPersonalData(
        managed.roleTypeCode,
        managed.storeTypeCode,
        isHqSharingConsented,
      )
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
   * isPlatformAdmin 과 같은 규칙에 403 문구를 가를 수 있게 사용할 수 없는 계정을 나눠 준다 — 사용 중인 관리자
   * 계정이 아니면 unavailable, 플랫폼 BP 의 PM · PA 가 아니면 denied.
   */
  async platformAdminAccess(
    adminAccountId: number,
  ): Promise<'allowed' | 'denied' | 'unavailable'> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { roleTypeCode: true, bpCode: { select: { isPlatform: true } } },
    });
    if (!admin) return 'unavailable';
    return admin.bpCode.isPlatform && ['PM', 'PA'].includes(admin.roleTypeCode)
      ? 'allowed'
      : 'denied';
  }

  /**
   * 플랫폼 계정이 고를 고객 BP — 미삭제 · 플랫폼이 아닌 BP 를 사용 · 미사용 · 탈퇴 모두(2026-10-19, 서비스 바로가기
   * 「웨일ERP」의 BP 선택). keyword 는 상호 · BP코드 부분 일치다. 누가 불러도 되는지는 부르는 쪽이 정한다.
   */
  async listBps({
    keyword,
    page,
    pageSize,
  }: {
    keyword?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.BpCodeWhereInput = {
      isDeleted: false,
      isPlatform: false,
      ...(keyword && {
        OR: [
          { tradeName: containsText(keyword) },
          { bpCode: containsText(keyword) },
        ],
      }),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.bpCode.findMany({
        where,
        select: {
          bpCodeId: true,
          bpCode: true,
          tradeName: true,
          accountStatusCode: true,
        },
        orderBy: [{ bpCode: 'asc' }, { bpCodeId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.bpCode.count({ where }),
    ]);
    return { items, total };
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
