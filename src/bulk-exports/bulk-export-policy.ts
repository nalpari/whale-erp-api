import type { Prisma } from '@prisma/client';
import { hqVisibleWhere } from '../admin-scope/hq-visible';
import { addMonths, kstToday } from '../staff-members/kst-date';

// 직원 자료 일괄 저장(WHALEERP-336, 운영 정책 RET-09 · ATT-30). 판정만 모은다 — DB · 저장소는 서비스가 다룬다.

/** 요청할 수 있는 권한 유형 — BP 마스터 · 가맹마스터. 그 밖의 역할은 403 */
export const BULK_EXPORT_ROLES = ['BM', 'FM'] as const;
/** 받을 수 있는 기한 — 완료부터 7일. 지나면 매일 배치가 파일을 지운다 */
export const BULK_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 시도 횟수 — 첫 시도가 실패하면 한 번 더 */
export const BULK_EXPORT_MAX_ATTEMPTS = 2;
/**
 * 한 파일에 담는 계약서 파일 · 명세서 PDF 의 합 상한. zip 을 메모리에 한 번에 만들어서(zipArchive 의 ponytail) 넘으면 힙이 모자란다.
 * 넘으면 다시 해도 같으므로 바로 실패로 끝내고 점포를 나눠 다시 요청하게 한다.
 */
export const BULK_EXPORT_MAX_BYTES = 200 * 1024 * 1024;
export const TOO_LARGE_MESSAGE =
  '파일이 너무 큽니다. 점포를 나눠 다시 요청해 주세요.';
/** 퇴직자는 퇴직일 다음 날부터 3년이 지나지 않은 사람까지 담는다(2026-10-29 재영) */
const RETIRED_KEEP_MONTHS = 36;

export interface ScopeStore {
  storeId: number;
  storeTypeCode: string;
  storeStatusCode: string;
}

/**
 * 파일에 담을 직원 레코드. 범위 점포의 직원 가운데 임시저장이 아닌 근로계약이 하나라도 있고(재직, 운영 정책 CTR-29),
 * 재직이거나 퇴직일이 오늘(한국) − 3년 이후인 사람. BP 마스터는 가맹 점포에서 본사 제공 동의한 직원만(hqVisibleWhere)이고,
 * 폐점한 가맹 점포의 직원은 모두 뺀다(ATT-30 · RET-09). 직영이 아니면(모르는 유형 포함) 가맹으로 본다 — hidesPersonalData 와
 * 같이 판단이 틀릴 때 빼는 쪽이다.
 */
export function targetStaffWhere(
  roleTypeCode: string,
  stores: readonly ScopeStore[],
  now: Date,
): Prisma.StaffMemberWhereInput & { AND: Prisma.StaffMemberWhereInput[] } {
  return {
    AND: [
      visibleStaffWhere(roleTypeCode, stores),
      { contracts: { some: { status: { not: 'DRAFT' } } } },
      {
        OR: [
          { employmentStatus: 'EMPLOYED' },
          {
            employmentStatus: 'RETIRED',
            retiredDate: {
              gte: addMonths(kstToday(now), -RETIRED_KEEP_MONTHS),
            },
          },
        ],
      },
    ],
  };
}

/**
 * 그 점포들에서 이 역할의 파일에 담아도 되는 직원 — BP 마스터는 폐점한 가맹 점포를 빼고 가맹 점포는 본사 제공 동의한 직원만.
 * 파일을 만들 때(targetStaffWhere)와 BP 마스터가 내려받기 직전에 다시 볼 때 같이 쓴다(2026-10-29 재영, RET-09).
 */
export function visibleStaffWhere(
  roleTypeCode: string,
  stores: readonly ScopeStore[],
): Prisma.StaffMemberWhereInput {
  // 폐점한 가맹 점포는 hqVisibleWhere 가 동의해도 가린다(WHALEERP-137)
  return hqVisibleWhere(
    roleTypeCode,
    stores.map((s) => s.storeId),
    new Map(stores.map((s) => [s.storeId, s])),
  ).staff;
}

/** 요청 범위 — 비면 관리하는 점포 전부, 관리하지 않는 점포가 섞이면 null(400). 겹침 없이 오름차순 */
export function resolveStoreIds(
  requested: readonly number[] | undefined,
  managed: readonly number[],
): number[] | null {
  const ids = [...new Set(requested?.length ? requested : managed)].sort(
    (a, b) => a - b,
  );
  const owned = new Set(managed);
  return ids.every((id) => owned.has(id)) ? ids : null;
}

/** 같은 BP 안에서 만드는 중인 요청을 하나만 두는 키 — 부분 고유 인덱스 (bp_code_id, scope_key) */
export function scopeKeyOf(roleTypeCode: string, storeIds: readonly number[]) {
  return `${roleTypeCode}:${storeIds.join(',')}`;
}

/**
 * 목록 · 내려받기 — 요청한 사람만이 아니라, 같은 BP · 같은 권한 유형이고 지금 요청의 점포를 모두 관리하는 마스터면 본다
 * (2026-10-29 재영). 권한 유형까지 맞추는 것은 가맹마스터 파일(동의로 가리지 않음)이 BP 마스터에게 보이지 않게다.
 */
export function isVisibleTo(
  row: { bpCodeId: number; roleTypeCode: string; storeIds: readonly number[] },
  viewer: {
    bpCodeId: number;
    roleTypeCode: string;
    storeIds: readonly number[];
  },
): boolean {
  const managed = new Set(viewer.storeIds);
  return (
    row.bpCodeId === viewer.bpCodeId &&
    row.roleTypeCode === viewer.roleTypeCode &&
    row.storeIds.every((id) => managed.has(id))
  );
}

/** 파일·폴더 이름에 쓸 수 없는 글자(경로 · 따옴표 · 제어 문자)는 밑줄 — payslipPdfFileName 과 같다. 점만 있는 이름도 밑줄 */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  // 점만 있는 조각(. · ..)은 zip 을 푸는 쪽에서 위 폴더로 읽힌다(zip-slip)
  return /^\.+$/.test(safe) ? '_' : safe;
}

/** 직원자료_{BP명}_{YYYYMMDD}.zip — 요청한 한국 날짜 */
export function bulkExportFileName(bpName: string, now: Date): string {
  const ymd = kstToday(now).toISOString().slice(0, 10).replaceAll('-', '');
  return `직원자료_${safeName(bpName)}_${ymd}.zip`;
}
