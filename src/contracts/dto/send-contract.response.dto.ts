import { ApiProperty } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';

/** 재발송 결과(WHALEERP-136 · 611 · 130) */
export class SendContractResponseDto {
  contractId: number;

  /**
   * 보낸 뒤의 상태 — 가입 초대는 그대로(발송 대기 · 서명 대기), 가입한 직원은 서명 대기, 소속 추가 확인 요청은 발송 대기(직원이
   * 수락하면 서명 대기)
   */
  // enumName 을 주면 다른 DTO 의 ContractStatus 스키마와 설명을 나눠 써 한쪽 설명이 덮인다 — 여기서는 펼쳐 둔다
  @ApiProperty({ enum: ContractStatus })
  status: ContractStatus;

  /** 이번 발송 일시 */
  sentAt: string;

  /** 새 날인 기한(보낸 때부터 30일). 소속 추가 확인 요청은 직원이 수락한 때부터 세어 아직 없다(null) */
  @ApiProperty({ nullable: true, type: String })
  signDeadlineAt: string | null;
}
