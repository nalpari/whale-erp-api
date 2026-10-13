import { hidesPersonalData } from '../admin-scope/admin-scope.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * 운영 알림을 받을 관리자를 고른다(운영 정책 NTF-04). 업무 쪽이 `OpsNotificationService.notify` 의
 * `recipients` 를 이 셋으로 만든다. 모두 사용 중인 관리자 계정만 고른다.
 */
export type RecipientsPrisma = Pick<PrismaService, 'adminAccount' | 'store'>;

const ACTIVE = { isDeleted: false, accountStatusCode: 'ACTIVE' } as const;
const PLATFORM_ROLES = ['PM', 'PA'];
const BUSINESS_ROLES = ['BM', 'BA', 'FM', 'FA'];

/** 플랫폼 마스터·플랫폼 관리자 — 문의사항·도입문의 접수, 도입문의 처리 상태 변경 */
export async function platformOperators(
  prisma: RecipientsPrisma,
): Promise<number[]> {
  const rows = await prisma.adminAccount.findMany({
    where: { ...ACTIVE, roleTypeCode: { in: PLATFORM_ROLES } },
    select: { adminAccountId: true },
  });
  return rows.map((r) => r.adminAccountId);
}

/**
 * 그 점포를 맡은 사업자 관리자 — 근로계약 날인·거부·만료, 계약 갱신 예정. 점포 BP 의 관리자 가운데 전체
 * 점포(`is_all_stores`)이거나 그 점포가 매핑된 사람이다. 알림 제목에 직원 이름이 들어가므로 직원 목록과 같은
 * 가림 기준을 쓴다 — 가맹 점포면 BP 마스터·BP 관리자는 받지 않는다.
 * ponytail: NOTIFY-13(기획 세션 결정 대기)의 임시 후보 A. 정해지면 이 필터만 바꾼다.
 */
export async function storeManagers(
  prisma: RecipientsPrisma,
  storeId: number,
): Promise<number[]> {
  const store = await prisma.store.findFirst({
    where: { storeId, isDeleted: false },
    select: { bpCodeId: true, storeTypeCode: true },
  });
  if (!store) return [];

  const rows = await prisma.adminAccount.findMany({
    where: {
      ...ACTIVE,
      bpCodeId: store.bpCodeId,
      roleTypeCode: { in: BUSINESS_ROLES },
      OR: [
        { isAllStores: true },
        { storeMappings: { some: { storeId, isDeleted: false } } },
      ],
    },
    select: { adminAccountId: true, roleTypeCode: true },
  });
  return rows
    .filter((r) => !hidesPersonalData(r.roleTypeCode, store.storeTypeCode))
    .map((r) => r.adminAccountId);
}

/** 정해진 한 사람 — 문의사항 답변(등록한 사람), 가입 연결 보류·소속 추가 확인 거절(초안을 쓴 관리자) */
export async function activeAdmin(
  prisma: RecipientsPrisma,
  adminAccountId: number,
): Promise<number[]> {
  const row = await prisma.adminAccount.findFirst({
    where: { adminAccountId, ...ACTIVE },
    select: { adminAccountId: true },
  });
  return row ? [row.adminAccountId] : [];
}
