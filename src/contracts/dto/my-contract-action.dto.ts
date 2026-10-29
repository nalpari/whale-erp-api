import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { REJECT_REASON_MAX } from '../contract-status';

/** 보내지 않았을 때만 건너뛴다 — null 은 400(@IsOptional 은 null 도 건너뛴다) */
const sent = (_: object, value: unknown) => value !== undefined;

/**
 * 직원 날인(WHALEERP-145) — multipart 의 텍스트 칸. 서명 이미지는 파일 칸 `signature`(PNG).
 * `sentAt` 은 직원이 본 계약의 발송 일시다(필수) — 그사이 관리자가 고쳐 다시 보냈으면 409 CONTRACT_RESENT.
 * 빠뜨리면 바뀐 계약서에 날인하게 되고, 시간대 표기가 없으면 서버 시간대로 읽혀 같은 발송도 409 가 되므로
 * 둘 다 400 이다(2026-10-21 김민식). 앱은 계약 조회에서 받은 값을 그대로 보낸다.
 */
export class SignMyContractDto {
  @ApiProperty({
    description:
      '직원이 본 계약의 발송 일시(ISO 8601, 시간대 표기 필수) — 다르면 409',
    example: '2026-10-21T01:00:00.000Z',
  })
  @IsISO8601({ strict: true }, { message: '발송 일시 형식이 아닙니다.' })
  @Matches(/T.*(Z|[+-]\d{2}:?\d{2})$/, {
    message: '발송 일시에 시간대(Z · +09:00)를 넣어 주세요.',
  })
  sentAt: string;
}

/** 직원 거부 — 사유는 선택이다(WHALEERP-145). 앞뒤 공백을 지우고(길이도 지운 뒤로 센다), 비면 남기지 않는다 */
export class RejectMyContractDto {
  @ApiPropertyOptional({ maxLength: REJECT_REASON_MAX })
  @ValidateIf(sent)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @MaxLength(REJECT_REASON_MAX, {
    message: `거부 사유는 ${REJECT_REASON_MAX}자 이하로 입력해 주세요.`,
  })
  reason?: string;
}

export class MyContractActionResponseDto {
  @ApiProperty()
  contractId: number;

  @ApiProperty({ enum: ContractStatus, enumName: 'ContractStatus' })
  status: ContractStatus;
}

export class SignedMyContractResponseDto extends MyContractActionResponseDto {
  @ApiProperty({ description: '날인 시각' })
  signedAt: Date;
}
