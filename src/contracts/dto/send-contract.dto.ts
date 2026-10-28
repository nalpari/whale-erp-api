import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';
import { IsEnum, IsISO8601, IsOptional, Matches } from 'class-validator';

/**
 * 재발송(POST /contracts/:contractId/send) 본문 — 화면이 본 계약의 상태 · 발송 시각. 둘 다 비워도 된다(옛 화면, 전처럼 보낸다).
 * 보낸 값이 지금 계약과 다르면 409 CONTRACT_STATUS_CONFLICT 다 — 낡은 화면에서 다시 보내지 않게(front #136 재리뷰).
 */
export class SendContractDto {
  /**
   * 화면이 본 계약 상태. 재발송은 서명 대기 · 발송 대기 · 거부 · 만료를 모두 받아, 이 값이 없으면 열어 둔 서명 대기 화면에서 그사이
   * 거부 · 만료된 계약을 모르고 되살린다
   */
  @ApiPropertyOptional({ enum: ContractStatus, enumName: 'ContractStatus' })
  @IsOptional()
  @IsEnum(ContractStatus)
  expectedStatus?: ContractStatus;

  /**
   * 화면이 본 마지막 발송 시각(상세 lastSentAt, ISO 8601). 재발송하면 바뀐다 — 상태가 그대로인 발송 대기 · 서명 대기를 두 탭에서 각각
   * 다시 보내면 상태만으로는 잡히지 않아 알림이 두 번 가고 앞 초대 코드가 무효가 된다. 아직 보낸 적 없으면(lastSentAt null) 비운다
   */
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  // 시간대가 없는 시각은 서버 시간대에 따라 다른 순간이 된다 — Z 나 ±hh:mm 이 있어야 한다(셀프 code-review)
  @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/, {
    message:
      'expectedSentAt 은 시간대(Z 또는 ±hh:mm)가 있는 ISO 8601 일시여야 합니다',
  })
  expectedSentAt?: string;
}
