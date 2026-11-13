import { FacilityDocumentKind } from '@prisma/client';

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

/** 전화번호(하이픈 뗀 숫자) — 국내 번호 9~12자리. DB CHECK `facilities_phone_format` 과 같다. */
export const PHONE_PATTERN = /^[0-9]{9,12}$/;
/**
 * 구매처 · A/S센터 전화번호 — 국내 번호에 더해 15xx · 16xx · 18xx 전국 대표번호 8자리(1588-1234). 8자리를 아무 번호나
 * 받으면 끝자리를 빠뜨린 010-1234 같은 번호도 통과하므로 대표번호 앞자리로 묶는다. 영업사원 · 관리 담당자는 사람
 * 번호라 받지 않는다.
 */
export const COMPANY_PHONE_PATTERN = /^(?:[0-9]{9,12}|(?:15|16|18)[0-9]{6})$/;

/** 문서 종류 — DB enum 그대로. 경로 `/facilities/:id/documents/:kind` 의 kind 다. */
export const FACILITY_DOCUMENT_KINDS = Object.values(FacilityDocumentKind);
/** 문서 한 개의 상한 — JPG · PNG · PDF 10MB 이하(PL-5), DB CHECK 와 같다. */
export const FACILITY_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

const DOCUMENT_KIND_LABELS = {
  USER_MANUAL: '사용 매뉴얼',
  PRECAUTION: '주의사항',
  WARRANTY: '제품 보증서',
} satisfies Record<FacilityDocumentKind, string>;

/** 문서 종류의 한글 — 오류 문구에 쓴다. */
export function documentKindLabel(kind: FacilityDocumentKind): string {
  return DOCUMENT_KIND_LABELS[kind];
}

/** 총금액 = 단가 × 수량. 단가가 없으면 null. 최대값(10자리 × 9,999)도 안전한 정수 범위다. */
export function totalAmountOf(
  unitPrice: number | null,
  quantity: number,
): number | null {
  return unitPrice === null ? null : unitPrice * quantity;
}

/** 경로의 문서 종류. 모르는 값이면 null(부르는 쪽이 404). hasOwn 으로 본다 — 'toString' 같은 값을 거른다. */
export function documentKindOf(raw: string): FacilityDocumentKind | null {
  return Object.hasOwn(DOCUMENT_KIND_LABELS, raw)
    ? (raw as FacilityDocumentKind)
    : null;
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
