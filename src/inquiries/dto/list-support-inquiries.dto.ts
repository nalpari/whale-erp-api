import { ApiProperty } from '@nestjs/swagger';
import { InquiryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { NO_NUL } from '../../common/no-nul';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';
import { trimText } from '../../platform-admins/platform-admin-format';

/** 고객지원 내 문의 목록 검색. 조건은 모두 AND, 주지 않으면 내 문의 전체. */
export class ListSupportInquiriesDto extends PageDto {
  /** 답변 상태 — 접수 · 처리중 · 답변완료. 화면의 「답변 대기」는 접수다. */
  @ApiProperty({
    enum: InquiryStatus,
    enumName: 'InquiryStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(InquiryStatus)
  status?: InquiryStatus;

  /** 제목에 들어 있으면 나온다. */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(200)
  @Matches(NO_NUL, { message: '제목에 쓸 수 없는 문자가 있습니다' })
  title?: string;
}
