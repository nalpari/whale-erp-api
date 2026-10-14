import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class CodeValueDto {
  /** 상세코드. 저장 · 전송 값. 예: KB */
  value: string;
  /** 코드명. 화면에 보이는 값. 예: 국민은행 */
  label: string;
  /** 선택지 순서. 1부터. */
  order: number;
}

@ApiExtraModels(CodeValueDto)
export class CodeItemsResponseDto {
  // 키가 정해지지 않은 맵은 플러그인이 값 모양을 그리지 못한다. 직접 적는다(enum.response.dto 와 같다).
  /** 그룹 코드 → 상세코드 목록 */
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: { $ref: getSchemaPath(CodeValueDto) },
    },
    example: { BANK: [{ value: 'KB', label: '국민은행', order: 1 }] },
  })
  codes: Record<string, CodeValueDto[]>;
}
