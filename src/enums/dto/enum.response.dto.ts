import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class EnumValueDto {
  /** 저장·전송 값. 예: PENDING_SEND */
  value: string;
  /** 화면에 보이는 한글. 예: 발송 대기 */
  label: string;
  /** 선택지 순서. 1부터. */
  order: number;
}

@ApiExtraModels(EnumValueDto)
export class EnumCatalogResponseDto {
  /** enum 내용의 해시. 내용이 바뀌면 바뀐다 — 클라이언트는 이 값이 같으면 캐시를 그대로 쓴다. */
  @ApiProperty({ example: '37eab9c919dce591' })
  version: string;
  // 키가 정해지지 않은 맵(Record)은 플러그인이 값 모양을 그리지 못해 items: true 로 남긴다. 직접 적는다.
  /** enum 이름(enumName 과 같은 PascalCase) → 값 목록 */
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: { $ref: getSchemaPath(EnumValueDto) },
    },
    example: {
      ContractStatus: [
        { value: 'PENDING_SEND', label: '발송 대기', order: 1 },
        { value: 'PENDING_SIGNATURE', label: '서명 대기', order: 2 },
        { value: 'SIGNED', label: '체결 완료', order: 3 },
      ],
    },
  })
  enums: Record<string, EnumValueDto[]>;
}
