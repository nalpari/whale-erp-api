import type { TargetBpContext } from '../auth/menu-permission.guard';

/** 엑셀을 요청한 관리자와, 그 화면이 쓰는 대상 BP(탭 BP 를 쓰지 않는 화면은 null). */
export type ExcelExportCaller = {
  adminAccountId: number;
  bp: TargetBpContext | null;
};

/**
 * 화면 하나의 엑셀. 공통 모듈(ExcelExportsService)이 1분 제한 · 생성 중 거절 · 바로 받기와 예약 생성 · 이력 · 메일 ·
 * 내려받기 링크를 맡고, 화면은 건수 세기와 파일 만들기만 준다. 예약 생성은 나중에 배치가 저장해 둔 검색 조건으로
 * 다시 부르므로 count · build 는 요청 객체(req)에 기대지 않는다.
 */
export interface ExcelExportSource<Q extends object = object> {
  /** menus.url — 같은 화면 판단과 이력의 menu_id. 컨트롤러 경로의 메뉴와 같다(예: /stores). */
  readonly menuUrl: string;
  /** 메일에 넣는 화면 이름(예: 점포 목록). */
  readonly screenName: string;
  /** 저장해 둔 검색 조건(JSON)을 다시 이 클래스로 읽는다 — class-transformer 의 변환이 다시 적용된다. */
  readonly queryType: new () => Q;
  /** 내려받는 파일 이름 — 한국 날짜가 붙는다(예: 점포목록_20261028.xlsx). */
  fileName(now: Date): string;
  /** 목록과 같은 조건으로 센 건수. 범위 · 권한 거절(4xx)은 여기서 던진다 — 그때는 이력을 남기지 않는다. */
  count(caller: ExcelExportCaller, query: Q): Promise<number>;
  /** 목록과 같은 조건 · 순서로 전부 담은 xlsx. */
  build(caller: ExcelExportCaller, query: Q): Promise<Buffer>;
  /**
   * 메뉴 조회 권한 밖의, 화면만의 호출자 조건(예: BP 목록은 플랫폼 계정만). 예약 생성 파일을 내려받을 때 공통 엑셀이
   * 메뉴 권한과 함께 다시 부른다 — 만든 뒤 24시간 안에 조건을 잃으면 받지 못하게. 없으면 메뉴 권한만 본다.
   */
  assertRequester?(adminAccountId: number): Promise<void>;
  /**
   * 요청자가 지금 볼 수 있는 데이터 범위의 지문(예: 점포 — 대상 BP · 전체 점포 · 매핑 점포). 예약 생성 파일을 만들 때
   * 남기고, 받을 때 다시 물어 다르면 403 이다 — 만든 뒤 범위가 좁아진 사람이 그 전 범위의 파일을 받지 않게. 범위가 없는
   * 화면(BP 목록 — 플랫폼 전체)은 두지 않는다.
   */
  scopeKey?(caller: ExcelExportCaller): Promise<string>;
}
