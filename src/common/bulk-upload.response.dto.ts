import { ApiProperty } from '@nestjs/swagger';

/** 미리보기 표의 열 하나 — 화면은 이 순서 · 이름으로 표를 그린다 */
export class BulkPreviewColumnDto {
  /** rows[].values 의 키 @example storeName */
  key: string;
  /** 열 이름 @example 점포 */
  label: string;
}

/** 미리보기 한 줄 */
export class BulkPreviewRowDto {
  /** 엑셀 행 번호(머리글이 1행) @example 3 */
  rowNumber: number;
  /** 오류가 없으면 true */
  isValid: boolean;
  /** 열 키 → 화면에 보일 글자(코드가 아니라 한글 · 점포명). 빈 칸은 빈 글자 */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { storeName: '성수점', name: '제빙기' },
  })
  values: Record<string, string>;
  /** 「칸 이름: 사유」 목록 — 정상 줄은 빈 배열 @example ["분류: 「점포 장비」에 없는 분류입니다."] */
  errors: string[];
}

/** POST /facilities/bulk-validations 응답 — 일괄 등록 공통 미리보기 모양 */
export class BulkPreviewResponseDto {
  /** 올린 파일 이름 */
  fileName: string;
  /** 내용이 있는 줄 수 */
  totalCount: number;
  validCount: number;
  errorCount: number;
  /** 표에 보일 열 — 자원마다 다르다 */
  columns: BulkPreviewColumnDto[];
  rows: BulkPreviewRowDto[];
}

/** POST /facilities/bulk 응답 */
export class BulkCreateResponseDto {
  /** 등록한 건수 @example 12 */
  createdCount: number;
}
