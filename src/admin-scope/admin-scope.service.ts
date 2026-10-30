import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { containsText } from '../common/contains-text';
import { PrismaService } from '../prisma/prisma.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from './hq-sharing';

/** 관리자가 관리하는 점포와 그 관리자의 권한 유형(공통코드 ROLE_TYPE — PM · PA · BM · BA · FM · FA). */
export interface ManageableStores {
  roleTypeCode: string;
  stores: ({ storeId: number } & MaskingStore)[];
}

/** 가림 판정에 쓰는 점포 — 유형과 상태(폐점이면 가맹 관계가 끝났다) */
export interface MaskingStore {
  storeTypeCode: string;
  storeStatusCode: string;
}

/**
 * 본사 역할(BP 마스터 · BP 관리자). 가맹 점포 직원은 본사 제공 동의를 한 경우에만 개인 단위로 본다
 * (운영 정책 ATT-30, 동의 칸 `accounts.is_hq_sharing_consented` — 계정에 하나, 2026-10-20. 처음에는 직원 레코드 칸, #137).
 */
const HQ_ROLES = new Set(['BM', 'BA']);

/**
 * 이 역할에게 이 점포 직원의 개인 정보를 가리는가. 직원 목록의 가린 행 · 개인 칸 필터와 직원 단위 API 의 거부가
 * 같은 기준을 쓴다 — 목록에서 가린 직원을 ID 로 찾아가 보거나 퇴직 처리하면 가림이 소용없다. 직영이 아니면(모르는
 * 유형 포함) 동의하지 않은 직원을 가린다. 개인정보 규칙은 판단이 틀릴 때 가리는 쪽이어야 한다. 철회하면 동의 칸이
 * false 라 다시 가려진다.
 *
 * 폐점한 가맹 점포(BP 회원 탈퇴로 닫힌 점포 포함)는 가맹 관계가 끝나 그 레코드에는 동의를 더 적용하지 않는다 — 계정이
 * 동의했어도 가린다. 계정의 동의 자체는 그대로라 다른 소속에는 계속 적용된다(운영 정책 ATT-30 v227, 2026-10-28 재영).
 * 점포를 모르면(관리 범위에 없음) 같은 이유로 가린다.
 */
export function hidesPersonalData(
  roleTypeCode: string,
  store: MaskingStore | undefined,
  isHqSharingConsented: boolean,
): boolean {
  return (
    HQ_ROLES.has(roleTypeCode) &&
    store?.storeTypeCode !== 'DIRECT' &&
    !(
      isHqSharingConsented &&
      store !== undefined &&
      store.storeStatusCode !== 'CLOSED'
    )
  );
}

/**
 * 가려지는 점포 가운데 본사 제공 동의한 직원은 보이는 점포인가 — 본사 역할에게 폐점하지 않은 가맹(직영 아님) 점포다. where
 * 로 「가려지는 점포는 동의한 직원만」을 만들 때 동의 조건(HQ_SHARING_CONSENTED)을 걸 점포이고, 폐점한 가맹 점포는 동의해도
 * 가리므로 빠진다. hidesPersonalData(…, false) 이면서 hidesPersonalData(…, true) 가 아닌 점포와 같다.
 */
export function consentOpensStore(
  roleTypeCode: string,
  store: MaskingStore | undefined,
): boolean {
  return (
    HQ_ROLES.has(roleTypeCode) &&
    store !== undefined &&
    store.storeTypeCode !== 'DIRECT' &&
    store.storeStatusCode !== 'CLOSED'
  );
}

/** 아무 직원 레코드도 걸리지 않는 조건 — HQ_SHARING_CONSENTED 와 같은 `account` 키라 같은 자리에 넣는다 */
const NO_STAFF = {
  account: { is: { accountId: { in: [] } } },
} as const satisfies Prisma.StaffMemberWhereInput;

/**
 * 가려지는 점포(`hidesPersonalData(…, false)`)에서 이 역할에게 보이는 직원의 직원 레코드 조건 — 동의한 직원만이고, 폐점한
 * 가맹 점포면 아무도 없다(ATT-30 v227). 직원 레코드 where 에 펼쳐 넣는다.
 */
export function hiddenStoreStaffWhere(
  roleTypeCode: string,
  store: MaskingStore | undefined,
): Prisma.StaffMemberWhereInput {
  return consentOpensStore(roleTypeCode, store)
    ? HQ_SHARING_CONSENTED
    : NO_STAFF;
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
 * 플랫폼 계정인가 — 권한 유형 PM · PA 이면서 소속 BP 가 플랫폼 BP. 권한 유형만 보면 고객 BP 에 잘못 붙은 PM · PA 가
 * 통과하므로 둘 다 본다. 플랫폼 계정 판정은 모두 이것을 쓴다 — 메뉴 권한 가드(platformOnly), 이 서비스의
 * platformAdminAccess · bpStoresAccess, 점포 관리(StoreManagementService.loadCaller).
 */
export function isPlatformRole(
  roleTypeCode: string,
  isPlatformBp: boolean,
): boolean {
  return isPlatformBp && ['PM', 'PA'].includes(roleTypeCode);
}

/**
 * 관리자의 관리 범위. 기본은 사용 중인 관리자 계정이 소속 BP 의 점포를 관리한다 — 전체 점포(`is_all_stores`)면
 * 그 BP 의 모든 점포, 아니면 `admin_store_mappings` 에 매핑된 점포만이다.
 *
 * 직원 · 점포 판정은 탭 BP(가드가 정한 `@TargetBp()`)를 마지막 인자로 받는다 — 플랫폼 계정(PM · PA)은 그 고객
 * BP 의 점포 전부를 다루고 개인 정보도 가리지 않는다(2026-10-26 재영, WHALEERP-618). BP · 가맹 계정이면 `bp` 를
 * 보지 않아(scopeAdmin) 넘기지 않을 때와 같다 — 가드도 다른 BP 는 403 으로 막는다. 넘기지 않으면 소속 BP 기준이라
 * 플랫폼 계정은 고객 점포를 다루지 못한다 — 아직 탭 BP 로 옮기지 않은 모듈이 그렇다.
 */
@Injectable()
export class AdminScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 이 관리자가 그 직원 레코드를 다루는가 — 점포를 관리하고, 그 직원의 개인 정보가 가려지지 않아야 한다
   * (hidesPersonalData — 본사 역할이면 직영 점포 직원이거나, 폐점하지 않은 가맹 점포의 본사 제공 동의한 직원). 없거나 관리 범위 밖 직원이면
   * false. 범위를 먼저 정하고 찾는다(staffInScope).
   */
  async canManageStaffMember(
    adminAccountId: number,
    staffMemberId: number,
    bp?: TargetBpContext,
  ): Promise<boolean> {
    const found = await this.staffInScope(adminAccountId, staffMemberId, bp);
    return (
      found !== null &&
      !hidesPersonalData(
        found.roleTypeCode,
        found.store,
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
   *
   * 두 번째 쓰임: 직원 상세 근로계약 요약의 급여 계좌 보기(canViewPayrollAccount)도 이 판정을 쓴다 — 가맹 직원의
   * 급여 계좌는 본사 역할에게 동의와 상관없이 보이지 않는다(운영 정책 TAX-07 · TAX-08, 재영 2026-10-29). 재설정 링크
   * 정책만 바꾸려면 이 함수를 고치지 말고 나눌 것.
   */
  async canManageStaffAccount(
    adminAccountId: number,
    staffMemberId: number,
    bp?: TargetBpContext,
  ): Promise<boolean> {
    const found = await this.staffInScope(adminAccountId, staffMemberId, bp);
    return (
      found !== null &&
      !hidesPersonalData(found.roleTypeCode, found.store, false)
    );
  }

  /**
   * 관리 범위 안의 그 직원과 판정에 쓸 값. 관리 범위를 먼저 정하고 그 점포 안에서만 찾는다 — 직원을 먼저 찾고 그
   * 점포를 관리하는지 보면, 다른 BP 직원 ID 는 없는 ID 보다 쿼리가 더 돌아 같은 404 라도 응답 시간으로 그 ID 의
   * 직원이 있는지 드러난다(api #56 리뷰). 없는 직원 · 다른 BP 직원 · 범위 안 직원이 모두 같은 수의 쿼리(넷 — 계정의 본사 제공 동의를 함께 읽는다)를 거친다.
   * `findFirst` 는 행이 없어도 계정 쿼리를 보내므로 같다 — `findUnique` 로 바꾸면 없을 때만 하나 줄어 차이가 다시 생긴다. 직원
   * 상세(StaffMemberListService.findOne)와 같은 방식이다. 사용 중인 관리자가 아니거나 범위 밖이면 null.
   */
  private async staffInScope(
    adminAccountId: number,
    staffMemberId: number,
    bp?: TargetBpContext,
  ) {
    const manageable = await this.getManageableStores(adminAccountId, bp);
    if (!manageable) return null;
    const staff = await this.prisma.staffMember.findFirst({
      where: {
        staffMemberId,
        storeId: { in: manageable.stores.map((s) => s.storeId) },
      },
      select: { storeId: true, ...HQ_SHARING_SELECT },
    });
    if (!staff) return null;
    return {
      roleTypeCode: manageable.roleTypeCode,
      store: manageable.stores.find((s) => s.storeId === staff.storeId),
      isHqSharingConsented: hqSharingConsentedOf(staff),
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
    bp?: TargetBpContext,
  ): Promise<boolean> {
    const managed = await this.managedStore(adminAccountId, storeId, bp);
    return (
      managed !== null &&
      !hidesPersonalData(
        managed.roleTypeCode,
        managed.store,
        isHqSharingConsented,
      )
    );
  }

  /**
   * 사용 중인 플랫폼 관리자(플랫폼 BP 의 PM · PA)인가. 관리자 토큰은 BP · 가맹 관리자도 받는다. 세션 가드(JwtAuthGuard)는 세션만
   * 보고 계정 상태는 보지 않으므로(미사용 · 탈퇴는 갱신에서 끊긴다, 최대 1시간), 사용 중이 아닌 계정은 여기서
   * 거른다. 역할이 고객 BP 계정에 잘못 붙어도 통과하지 않게 플랫폼 BP 소속까지 본다.
   */
  async isPlatformAdmin(adminAccountId: number): Promise<boolean> {
    return (await this.platformAdminAccess(adminAccountId)) === 'allowed';
  }

  /**
   * 플랫폼 관리자 판정을 403 문구별로 나눈다 — 사용 중인 관리자 계정이 아니면 unavailable, 플랫폼 BP 의 PM · PA 가
   * 아니면 denied. isPlatformAdmin 도 이것으로 판정한다(bpStoresAccess 는 BP 비교와 한 조회에 묶여 isPlatformRole 을 직접 부른다).
   */
  async platformAdminAccess(
    adminAccountId: number,
  ): Promise<'allowed' | 'denied' | 'unavailable'> {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { roleTypeCode: true, bpCode: { select: { isPlatform: true } } },
    });
    if (!admin) return 'unavailable';
    return isPlatformRole(admin.roleTypeCode, admin.bpCode.isPlatform)
      ? 'allowed'
      : 'denied';
  }

  /**
   * 플랫폼 계정이 고를 고객 BP — 미삭제 · 플랫폼이 아닌 BP 를 사용 · 미사용 · 탈퇴 모두(2026-10-19, 서비스 바로가기
   * 「웨일ERP」의 BP 선택). keyword 는 상호 · BP코드 부분 일치, withMaster 면 BP 마스터 계정이 있는 BP 만. 누가 불러도 되는지는 부르는 쪽이 정한다.
   */
  async listBps({
    keyword,
    withMaster,
    page,
    pageSize,
  }: {
    keyword?: string;
    withMaster?: boolean;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.BpCodeWhereInput = {
      isDeleted: false,
      isPlatform: false,
      // BP 선택 팝업은 BP 마스터 계정이 있는 BP 만 — BP 마스터 계정 목록(bp-masters listWhere)과 같은 범위라 두 화면 건수가 같다(2026-10-29 사용자 지정).
      // 탭 BP 찾기 · 상태 확인은 같은 api 를 거르지 않고 부른다 — 계정이 없는 BP 도 열려야 한다
      ...(withMaster && {
        adminAccounts: { some: { roleTypeCode: 'BM', isDeleted: false } },
      }),
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
        // 최신 등록이 위 — BP 마스터 계정 목록(bp-masters ORDER_BY)과 같은 순서(2026-10-29 사용자 지정, 전엔 BP 코드 오름차순)
        orderBy: [{ createdAt: 'desc' }, { bpCodeId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.bpCode.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * 이 관리자가 관리하는 점포 목록. 탭 BP 없이 부른 `canManageStore` 와 같은 규칙이다 — 사용 중 계정, 소속 BP 의
   * 미삭제 점포, 전체 점포가 아니면 매핑된 점포만. 관리자 웹 로그인 정보의 점포 선택지가 쓰고, 탭 BP 는 받지 않는다.
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
   * 아니면 unavailable — 세션 가드(JwtAuthGuard)가 계정 상태를 보지 않아 여기서 거른다. 다른 BP 는 denied(부르는 쪽이 404 로 답해
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
      return isPlatformRole(admin.roleTypeCode, admin.bpCode.isPlatform) ||
        admin.bpCodeId === bpCodeId
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
   * 그 BP 점포 목록의 버전 — 관리자 웹이 새로고침 · 메뉴 이동 · 창 포커스 때 묻고 값이 바뀌었을 때만 목록을 다시 받는다
   * (여러 PC 에서 같은 계정으로 쓰므로 다른 PC 의 변경을 잡는다). 형식은 정하지 않는다 — 비교만 한다. 없거나 삭제된
   * BP · 플랫폼 BP 면 null. 누가 불러도 되는지는 부르는 쪽이 bpStoresAccess 로 정한다.
   *
   * 담는 것: 그 BP 점포의 최근 수정 시각(지운 행까지 — 삭제도 updated_at 을 바꾼다)과 지우지 않은 점포 수(같은
   * 밀리초에 바뀌는 경우). BP · 가맹 관리자는 매핑으로 범위가 정해지므로 자기 매핑의 최근 수정 시각(지운 행까지) ·
   * 살아 있는 매핑 수와 계정 수정 시각(관리 점포 범위 is_all_stores)도 담는다. 플랫폼 계정 · 직원 앱은 점포만이다.
   * 대표 이미지는 점포 행을 바꾸지 않아 담지 않는다(선택기에 보이지 않는다). 모두 bp_code_id · 기본키 인덱스를 탄다.
   */
  async bpStoresVersion(
    user: AuthUser,
    bpCodeId: number,
  ): Promise<string | null> {
    const bp = await this.prisma.bpCode.findFirst({
      where: { bpCodeId, isDeleted: false, isPlatform: false },
      select: { bpCodeId: true },
    });
    if (!bp) return null;
    const [storesAt, liveStores, admin] = await Promise.all([
      this.prisma.store.aggregate({
        where: { bpCodeId },
        _max: { updatedAt: true },
      }),
      this.prisma.store.count({ where: { bpCodeId, isDeleted: false } }),
      user.type === 'admin'
        ? this.prisma.adminAccount.findFirst({
            where: { adminAccountId: user.id },
            select: {
              updatedAt: true,
              roleTypeCode: true,
              bpCode: { select: { isPlatform: true } },
            },
          })
        : null,
    ]);
    const parts: (string | number)[] = [
      'stores',
      msOf(storesAt._max.updatedAt),
      liveStores,
    ];
    if (admin && !isPlatformRole(admin.roleTypeCode, admin.bpCode.isPlatform)) {
      const [mappingsAt, liveMappings] = await Promise.all([
        this.prisma.adminStoreMapping.aggregate({
          where: { adminAccountId: user.id },
          _max: { updatedAt: true },
        }),
        this.prisma.adminStoreMapping.count({
          where: { adminAccountId: user.id, isDeleted: false },
        }),
      ]);
      parts.push(
        'mappings',
        msOf(mappingsAt._max.updatedAt),
        liveMappings,
        'account',
        admin.updatedAt.getTime(),
      );
    }
    // 내부 값(시각 · 개수)을 그대로 내보내지 않고 짧은 지문으로 — front 는 비교만 한다.
    return createHash('sha256')
      .update(parts.join(':'))
      .digest('base64url')
      .slice(0, 22);
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
    bp?: TargetBpContext,
  ): Promise<boolean> {
    return (await this.managedStore(adminAccountId, storeId, bp)) !== null;
  }

  /** 관리하는 점포면 관리자의 권한 유형과 점포(유형 · 상태), 아니면 null. */
  private async managedStore(
    adminAccountId: number,
    storeId: number,
    bp?: TargetBpContext,
  ): Promise<{ roleTypeCode: string; store: MaskingStore } | null> {
    const admin = await this.scopeAdmin(adminAccountId, bp);
    if (!admin) return null;
    // 전체 점포 관리자도 그 BP 의 점포만이다. 매핑은 BP 를 넘지 않는다는 보장이 DB 에 없어 함께 본다.
    const store = await this.prisma.store.findFirst({
      where: { storeId, bpCodeId: admin.bpCodeId, isDeleted: false },
      select: { storeTypeCode: true, storeStatusCode: true },
    });
    if (!store) return null;
    const managed = { roleTypeCode: admin.roleTypeCode, store };
    if (admin.isAllStores) return managed;
    const mapped = await this.prisma.adminStoreMapping.count({
      where: { adminAccountId, storeId, isDeleted: false },
    });
    return mapped > 0 ? managed : null;
  }

  /**
   * 관리하는 점포 전부. canManageStore 와 같은 규칙이다 — 사용 중인 계정, 그 BP(플랫폼 계정이 `bp` 를 넘기면 탭
   * BP, 아니면 소속 BP)의 삭제되지 않은 점포, 전체 점포가 아니면 삭제되지 않은 매핑의 점포만(플랫폼 계정이 `bp` 를
   * 넘기면 매핑을 보지 않는다). 계정이 없거나 사용 중이 아니면 null.
   */
  async getManageableStores(
    adminAccountId: number,
    bp?: TargetBpContext,
  ): Promise<ManageableStores | null> {
    const admin = await this.scopeAdmin(adminAccountId, bp);
    if (!admin) return null;
    const stores = await this.prisma.store.findMany({
      where: {
        bpCodeId: admin.bpCodeId,
        isDeleted: false,
        ...(admin.isAllStores
          ? {}
          : { adminMappings: { some: { adminAccountId, isDeleted: false } } }),
      },
      select: { storeId: true, storeTypeCode: true, storeStatusCode: true },
      orderBy: { storeId: 'asc' },
    });
    return { roleTypeCode: admin.roleTypeCode, stores };
  }

  /**
   * 판정에 쓸 사용 중인 관리자 계정과 점포를 찾을 BP. 플랫폼 계정이 탭 BP 를 넘기면 그 BP 의 전체 점포다. 플랫폼
   * 여부는 가드가 같은 요청에서 DB 로 정한 값을 쓴다 — 권한 유형 · 소속 BP 는 등록 뒤 바뀌지 않는다. 그 값을 가드
   * 밖에서 손으로 만들어도 BP · 가맹 계정이 다른 BP 전체로 넓어지지 않게 계정의 권한 유형(PM · PA)도 본다 — 이미
   * 읽은 칸이라 쿼리는 늘지 않는다. 소속 BP 가 플랫폼 BP 인지까지는 보지 않는다(isPlatformRole 은 가드가 본다).
   */
  private async scopeAdmin(adminAccountId: number, bp?: TargetBpContext) {
    const admin = await this.prisma.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false, accountStatusCode: 'ACTIVE' },
      select: { bpCodeId: true, isAllStores: true, roleTypeCode: true },
    });
    if (
      !admin ||
      !bp?.isPlatformCaller ||
      !['PM', 'PA'].includes(admin.roleTypeCode)
    )
      return admin;
    return { ...admin, bpCodeId: bp.bpCodeId, isAllStores: true };
  }
}

/** 버전 재료의 시각 — 행이 없으면 0. */
function msOf(at: Date | null): number {
  return at ? at.getTime() : 0;
}
