import { ApiProperty } from '@nestjs/swagger';
import { ReplyMailResult } from '@prisma/client';

/**
 * 답변 메일을 다시 보낸 결과(WHALEERP-597). 상세의 마지막 발송 결과 칸에도 보통 같은 값이 남는다 — 결과를 쓰기 전에
 * 뒤 발송이 시각을 다시 잡았으면 그쪽 결과가 남는다.
 */
export class LeadReplyMailResponseDto {
  @ApiProperty({ enum: ReplyMailResult, enumName: 'ReplyMailResult' })
  replyMailResult: ReplyMailResult;

  /** 보내려 한 시각. 같은 도입문의는 이 시각부터 1분이 지나면 다시 보낼 수 있다. */
  replyMailAttemptedAt: Date;
}
