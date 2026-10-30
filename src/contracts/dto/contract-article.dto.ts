import { ApiProperty } from '@nestjs/swagger';

/** 제3조 요일별 표의 한 줄 — 요일 · 시업 · 종업 · 휴게 · 근로 */
export class ContractTableRowDto {
  cells: string[];
  /** 근무하지 않는 날(휴무 · 주휴일) — 흐리게 그린다 */
  off: boolean;
}

/** 값 줄 하나 — 값이 빈 줄은 싣지 않는다 */
export class ContractValueDto {
  label: string;
  value: string;
}

/** 조항 안의 한 덩어리. TEXT 는 text, TABLE 은 header · tableRows, VALUES 는 values 만 있다 */
export class ContractBlockDto {
  @ApiProperty({ enum: ['TEXT', 'TABLE', 'VALUES'] })
  type: 'TEXT' | 'TABLE' | 'VALUES';
  text?: string;
  header?: string[];
  @ApiProperty({ type: [ContractTableRowDto], required: false })
  tableRows?: ContractTableRowDto[];
  @ApiProperty({ type: [ContractValueDto], required: false })
  values?: ContractValueDto[];
}

/** 근로계약서 조항 하나 — 보낸 원본 · 처리 완료본 PDF 와 같은 템플릿(WHALEERP-131). 첫 TEXT 는 제목 뒤에 잇는 문장이다 */
export class ContractArticleDto {
  /** 「제1조(근로계약기간)」 */
  title: string;
  @ApiProperty({ type: [ContractBlockDto] })
  blocks: ContractBlockDto[];
}
