import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { ANSWER_STATUSES, type AnswerStatus } from '../../common/answer-status';
import { toList } from '../../common/query-list';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';

/** 커뮤니티 관리 도입문의 목록 검색. 주지 않으면 전체. */
export class ListLeadsDto extends PageDto {
  /** 답변 대기(접수 · 처리중) · 답변 완료. 둘 다면 `?answerStatus=WAITING&answerStatus=ANSWERED`. */
  @ApiProperty({
    enum: ANSWER_STATUSES,
    enumName: 'InquiryAnswerStatus',
    isArray: true,
    required: false,
  })
  @IsOptional()
  @Transform(toList)
  @IsIn(ANSWER_STATUSES, { each: true })
  answerStatus?: AnswerStatus[];
}
