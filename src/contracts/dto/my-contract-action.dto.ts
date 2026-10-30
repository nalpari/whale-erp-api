import { ApiProperty } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsISO8601, Matches, ValidateBy } from 'class-validator';

/** 수정 요청 사유 길이 상한(WHALEERP-635). 직원 앱 입력칸과 맞춘다 — NFC 로 맞추고 앞뒤 공백을 지운 뒤 센다. */
export const CORRECTION_REASON_MAX = 100;

/**
 * 수정 요청 사유 — 다듬은 뒤 1~100자 문자열. 검사 하나로 묶어 400 문구가 늘 하나다 — 따로 두면 사유가 없을 때 「입력해 주세요」와
 * 「100자 이하로」가 함께 나가고, 직원 앱은 배열 문구를 이어 붙여 보인다.
 */
const CorrectionReason = () =>
  ValidateBy({
    name: 'correctionReason',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'string' &&
        v.length > 0 &&
        v.length <= CORRECTION_REASON_MAX,
      defaultMessage: (args) =>
        typeof args?.value === 'string' && args.value.length > 0
          ? `수정 요청 사유는 ${CORRECTION_REASON_MAX}자 이하로 입력해 주세요.`
          : '수정 요청 사유를 입력해 주세요.',
    },
  });

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

/**
 * 직원 수정 요청 — 사유는 필수다(WHALEERP-635, 2026-10-30 김민식). NFC 로 맞추고 앞뒤 공백을 지운 뒤 1~100자. 선택지는 두지 않는다.
 * 없거나 문자열이 아니거나 비면 「입력해 주세요」, 넘치면 「100자 이하로」.
 */
export class RequestMyContractCorrectionDto {
  @ApiProperty({
    description: '수정 요청 사유 — 앞뒤 공백을 지운 뒤 1~100자',
    minLength: 1,
    maxLength: CORRECTION_REASON_MAX,
    example: '시급이 안내받은 금액과 다릅니다',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @CorrectionReason()
  reason: string;
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
