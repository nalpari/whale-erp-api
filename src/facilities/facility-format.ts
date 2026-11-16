/** 장비 그룹 — 공통코드 그룹 두 개. 화면이 고정으로 알고 부른다. 그룹을 더하려면 화면 개발이 필요하다(정책서 PL-3). */
export const FACILITY_GROUPS = ['STORE_FACILITY', 'STORE_EQUIPMENT'] as const;
export type FacilityGroup = (typeof FACILITY_GROUPS)[number];

/** 운영상태 공통코드 그룹 — 플랫폼고정(운영 · 보관 · 폐기). BP 는 볼 수도 고칠 수도 없다(PL-2). */
export const FACILITY_STATUS_GROUP = 'FACILITY_STATUS';
/** 점검 주기 공통코드 그룹 — 플랫폼제공. 그룹 코드는 20자까지라 제안 이름(FACILITY_INSPECTION_CYCLE)을 줄였다. */
export const INSPECTION_CYCLE_GROUP = 'INSPECTION_CYCLE';

/** 목록 한 쪽 건수 — 50 · 100, 기본 50. */
export const FACILITY_PAGE_SIZES = [50, 100] as const;
export type FacilityPageSize = (typeof FACILITY_PAGE_SIZES)[number];

/** 단가 상한 — 숫자 10자리(PL-5). */
export const UNIT_PRICE_MAX = 9_999_999_999;
export const QUANTITY_MAX = 9_999;

/**
 * 전화번호(하이픈 뗀 숫자) — 국내 번호 9~12자리. 영업사원 · 관리 담당자 칸의 DB CHECK `facilities_phone_format` 식과
 * 같다.
 */
export const PHONE_PATTERN = /^[0-9]{9,12}$/;
/**
 * 구매처 · A/S센터 전화번호 — 국내 번호에 더해 15xx · 16xx · 18xx 전국 대표번호 8자리(1588-1234 → 15881234). 8자리를
 * 아무 번호나 받으면 지역번호를 빠뜨린 1234-5678 같은 번호도 통과하므로 대표번호 앞자리로 묶는다. 영업사원 · 관리
 * 담당자는 사람 번호라 받지 않는다. 구매처 · A/S센터 칸의 DB CHECK 식과 같다(20261113105855).
 */
export const COMPANY_PHONE_PATTERN = /^(?:[0-9]{9,12}|(?:15|16|18)[0-9]{6})$/;

/**
 * 문서 종류 공통코드 그룹 — 플랫폼고정(WHALEERP-718). 경로 `/facilities/:id/documents/:kind` 의 kind 가 이 그룹의 상세
 * 코드다. 플랫폼 관리자가 공통코드 관리에서 더하고 · 이름을 바꾸고 · 순서를 바꾸고 · 사용 중지한다. 모든 BP 가 플랫폼 원본을 쓴다.
 */
export const FACILITY_DOCUMENT_GROUP = 'FACILITY_DOCUMENT';
/** 문서 한 개의 상한 — JPG · PNG · PDF 10MB 이하(PL-5), DB CHECK 와 같다. */
export const FACILITY_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** 총금액 = 단가 × 수량. 단가가 없으면 null. 최대값(10자리 × 9,999)도 안전한 정수 범위다. */
export function totalAmountOf(
  unitPrice: number | null,
  quantity: number,
): number | null {
  return unitPrice === null ? null : unitPrice * quantity;
}

type LabelRow = { itemCode: string; bpCode: string; label: string };

/**
 * 상세 코드의 한글 — 점포 BP 의 행(BP 가 고친 이름)이 있으면 그것, 없으면 플랫폼 원본, 둘 다 없으면 코드 그대로.
 * 미사용 · 삭제된 코드도 이름을 보인다 — 그 코드를 쓰는 시설물·장비의 목록 · 상세에는 이름이 그대로 남는다(PL-3).
 */
export function pickLabel(
  rows: readonly LabelRow[],
  itemCode: string,
  bpCode: string,
): string {
  return (
    rows.find((r) => r.itemCode === itemCode && r.bpCode === bpCode)?.label ??
    rows.find((r) => r.itemCode === itemCode)?.label ??
    itemCode
  );
}
