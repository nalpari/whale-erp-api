import { ApiProperty } from '@nestjs/swagger';

// 엑셀 일괄 등록 공통 응답 — 자원마다 같은 네 경로(/{자원}/bulk-template · bulk-validations · bulk-error-file · bulk)가
// 이 클래스들을 쓴다(front 「일괄 등록 공통 API 요청」, 2026-11-12, 첫 적용은 시설물·장비). 새 자원은 이 클래스를 import 한다 —
// 같은 이름의 클래스를 따로 선언하면 OpenAPI 스키마(이름이 키)가 말없이 겹쳐 front 생성 타입이 한쪽 모양만 갖는다.

/** 미리보기 표의 열 하나 — 화면은 이 순서 · 이름으로 표를 그린다 */
export class BulkPreviewColumnDto {
  /** rows[].values 의 키 @example storeName */
  key: string;
  /** 열 이름 @example 점포 */
  label: string;
}

/** 미리보기 한 줄 */
export class BulkPreviewRowDto {
  /** 엑셀 행 번호(머리글이 1행이라 2부터, 줄마다 다르다) @example 3 */
  rowNumber: number;
  /** errors 가 비었으면 true */
  isValid: boolean;
  /** 열 키 → 화면에 보일 글자(코드가 아니라 한글 · 점포명). 키는 columns[].key 와 같은 집합이고, 빈 칸은 빈 글자 */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { storeName: '성수점', name: '제빙기' },
  })
  values: Record<string, string>;
  /** 「칸 이름: 사유」 목록(칸 순서) — 정상 줄은 빈 배열 @example ["분류: 「점포 장비」에 없는 분류입니다."] */
  errors: string[];
}

/** POST /{자원}/bulk-validations 응답 — 일괄 등록 공통 미리보기 모양. validCount + errorCount = totalCount = rows.length */
export class BulkPreviewResponseDto {
  /** 올린 파일 이름 */
  fileName: string;
  /** 내용이 있는 줄 수 */
  totalCount: number;
  /** 오류 없는 줄 수 */
  validCount: number;
  /** 오류 있는 줄 수 */
  errorCount: number;
  /** 표에 보일 열 — 자원마다 다르다 */
  columns: BulkPreviewColumnDto[];
  rows: BulkPreviewRowDto[];
}

/** POST /{자원}/bulk 응답 */
export class BulkCreateResponseDto {
  /** 등록한 건수 @example 12 */
  createdCount: number;
}
