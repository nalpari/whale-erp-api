import { ApiProperty } from '@nestjs/swagger';
import { InquiryStatus } from '@prisma/client';

/** 도입문의를 바꾼 뒤의 상태. 다음 저장(답변 · 메모)에 `updatedAt` 을 그대로 보낸다. */
export class LeadStateResponseDto {
  leadId: number;

  @ApiProperty({ enum: InquiryStatus, enumName: 'InquiryStatus' })
  status: InquiryStatus;

  updatedAt: Date;
}
