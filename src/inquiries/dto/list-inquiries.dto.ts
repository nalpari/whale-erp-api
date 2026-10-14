import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ANSWER_STATUSES, type AnswerStatus } from '../../common/answer-status';
import { NO_NUL } from '../../common/no-nul';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';
import { trimText } from '../../platform-admins/platform-admin-format';

/** 커뮤니티 관리 문의사항 목록 검색. 조건은 모두 AND, 주지 않으면 전체. */
export class ListInquiriesDto extends PageDto {
  /** 답변 대기(접수 · 처리중) 또는 답변 완료. */
  @ApiProperty({
    enum: ANSWER_STATUSES,
    enumName: 'InquiryAnswerStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(ANSWER_STATUSES)
  answerStatus?: AnswerStatus;

  /** 제목에 들어 있으면 나온다. */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(200)
  @Matches(NO_NUL, { message: '제목에 쓸 수 없는 문자가 있습니다' })
  title?: string;

  /** 보낸 곳 — BP 이름 · 점포 이름 · 보낸 사람 이름 중 하나에 들어 있으면 나온다. @example 한강상회 */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(100)
  @Matches(NO_NUL, { message: '보낸 곳에 쓸 수 없는 문자가 있습니다' })
  sender?: string;
}
