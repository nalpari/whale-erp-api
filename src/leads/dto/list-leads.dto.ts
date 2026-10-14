import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ANSWER_STATUSES, type AnswerStatus } from '../../common/answer-status';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';

/** 커뮤니티 관리 도입문의 목록 검색. 주지 않으면 전체. */
export class ListLeadsDto extends PageDto {
  /** 답변 대기(접수 · 처리중) 또는 답변 완료. */
  @ApiProperty({
    enum: ANSWER_STATUSES,
    enumName: 'InquiryAnswerStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(ANSWER_STATUSES)
  answerStatus?: AnswerStatus;
}
