/** 1만 건 이상이라 예약 생성으로 받은 요청(202). 파일은 다 만들어지면 등록한 이메일로 링크가 간다. */
export class ExcelScheduledResponseDto {
  /** 다운로드 이력 ID — 메일 링크와 `GET /excel-downloads/{id}` 가 쓴다. @example 41 */
  excelDownloadId: number;
  /** 담길 건수(요청 때 센 값). @example 12480 */
  rowCount: number;
  /** 화면에 그대로 보일 안내. */
  message: string;
}

/** 예약 생성한 엑셀의 내려받기 주소. 주소는 5분 동안만 쓸 수 있다 — 받자마자 연다. */
export class ExcelDownloadLinkResponseDto {
  /** S3 서명 주소(5분). */
  url: string;
  /** @example 점포목록_20261028.xlsx */
  fileName: string;
  /** 내려받기 기한(완료 + 24시간). @example 2026-10-29T05:05:00.000Z */
  expiresAt: string;
}
