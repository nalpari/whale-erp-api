import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isPlatformRole } from '../admin-scope/admin-scope.service';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from '../auth/access-messages';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import type { PrismaService } from '../prisma/prisma.service';

// 시설물·장비를 다루는 관리자와 그 점포 범위 — 화면 경로(FacilitiesService)와 엑셀 일괄 등록(FacilityBulkService)이 같이 쓴다.

/**
 * 시설물·장비를 다루는 관리자 — 가드가 메뉴 권한을 본 뒤 계정 한 행에서 읽어 둔다. 범위는 점포 정보 관리와 같다:
 * 플랫폼 계정은 상단에서 고른 BP 의 모든 점포, 그 밖의 계정은 소속 BP 의 점포(전체 점포가 아니면 매핑된 점포만).
 */
export type FacilityCaller = {
  adminAccountId: number;
  /** 권한 유형(공통코드 ROLE_TYPE) — 본사 역할(BM · BA)의 가맹 직원 개인정보 가림(ATT-30)에 쓴다 */
  roleTypeCode: string;
  isPlatform: boolean;
  isAllStores: boolean;
  /** 다루는 BP — 플랫폼 계정은 X-Bp-Code-Id 의 고객 BP, 그 밖의 계정은 소속 BP */
  targetBpCodeId: number;
  /** 그 BP 의 코드(BP+6자리) — 분류 · 점검 주기는 이 BP 의 공통코드 행이다 */
  targetBpCode: string;
};

/**
 * 사용 중인 관리자 계정과 다루는 BP. 플랫폼 계정이 BP 를 고르지 않았으면(대상 = 소속 플랫폼 BP) 400 — 플랫폼 BP 에는
 * 점포가 없다(점포 정보 관리와 같다).
 */
export async function loadFacilityCaller(
  prisma: PrismaService,
  callerId: number,
  bp: TargetBpContext,
): Promise<FacilityCaller> {
  const admin = await prisma.adminAccount.findFirst({
    where: {
      adminAccountId: callerId,
      isDeleted: false,
      accountStatusCode: 'ACTIVE',
    },
    select: {
      bpCodeId: true,
      isAllStores: true,
      roleTypeCode: true,
      bpCode: { select: { isPlatform: true, bpCode: true } },
    },
  });
  if (!admin) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
  const isPlatform = isPlatformRole(
    admin.roleTypeCode,
    admin.bpCode.isPlatform,
  );
  if (isPlatform && bp.bpCodeId === admin.bpCodeId)
    throw new BadRequestException('시설물·장비를 볼 BP 를 골라 주세요.');
  const targetBpCodeId = isPlatform ? bp.bpCodeId : admin.bpCodeId;
  const targetBpCode = isPlatform
    ? (
        await prisma.bpCode.findUniqueOrThrow({
          where: { bpCodeId: targetBpCodeId },
          select: { bpCode: true },
        })
      ).bpCode
    : admin.bpCode.bpCode;
  return {
    adminAccountId: callerId,
    roleTypeCode: admin.roleTypeCode,
    isPlatform,
    isAllStores: admin.isAllStores,
    targetBpCodeId,
    targetBpCode,
  };
}

/** 이 관리자가 보는 점포 — 점포 정보 관리의 범위와 같다(store-management.service scopeOf). */
export function storeScope(caller: FacilityCaller): Prisma.StoreWhereInput {
  return {
    isDeleted: false,
    bpCodeId: caller.targetBpCodeId,
    ...(!caller.isPlatform &&
      !caller.isAllStores && {
        adminMappings: {
          some: { adminAccountId: caller.adminAccountId, isDeleted: false },
        },
      }),
  };
}
