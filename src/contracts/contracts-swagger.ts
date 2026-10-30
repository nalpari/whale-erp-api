// 근로계약 관리자 경로(contracts · contract-send 컨트롤러)가 같이 쓰는 Swagger 설명 — 컨트롤러끼리 import 하지 않게 따로 둔다.

/** 가드가 정한 대상 BP 의 404 — 플랫폼 계정이 보낸 X-Bp-Code-Id 가 쓸 수 없는 BP 다(점포 정보 관리와 같다). */
export const BP_NOT_FOUND_DESCRIPTION =
  '플랫폼 계정의 X-Bp-Code-Id 가 없는 · 지운 · 플랫폼 BP 이거나 형식이 틀림(가드)';
/** 플랫폼 계정이 BP 를 고르지 않음 — 점포 정보 관리와 같은 400 이다. */
export const BP_MISSING_DESCRIPTION = '플랫폼 계정의 X-Bp-Code-Id 누락';
/** 가드의 다른 BP 403 — BP · 가맹 계정이 소속이 아닌 BP 를 보냄 · 형식이 틀린 헤더. 자기 403 설명을 단 경로는 이 문구를 덧붙인다(클래스 설명을 덮으므로) */
export const BP_FORBIDDEN_DESCRIPTION =
  'BP · 가맹 계정의 다른 BP · 형식이 틀린 헤더';
