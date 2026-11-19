/**
 * 점포를 보이는 이름 — 본사 점포(stores.is_hq)는 앞에 「[본사]」를 붙여 매장과 가른다(본사 점포 설계, 2026-11-17 사용자 지정).
 * 화면은 isHq 를 받아 같은 규칙(관리자 웹 storeOptionLabel)으로 붙이고, 파일처럼 api 가 글자로 내보내는 곳만 이것을 쓴다.
 */
export const storeLabelOf = (store: { name: string; isHq: boolean }): string =>
  store.isHq ? `[본사] ${store.name}` : store.name;
