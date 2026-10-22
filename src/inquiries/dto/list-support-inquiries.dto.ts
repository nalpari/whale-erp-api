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
import { toList } from '../../common/query-list';
import { PageDto } from '../../platform-admins/dto/list-platform-admins.dto';
import { trimText } from '../../platform-admins/platform-admin-format';

/** 고객지원 내 문의 목록 검색. 조건은 모두 AND, 주지 않으면 내 문의 전체. */
export class ListSupportInquiriesDto extends PageDto {
  /**
   * 답변 상태 — 접수 · 처리중 · 답변완료. 고객지원 화면은 「답변 대기 · 처리 중 · 답변 완료」 탭을 따로 두어(front
   * 목업 S-ITFILU) 「답변 대기」가 접수 하나다 — 접수 · 처리중을 합친 커뮤니티 관리의 `answerStatus` 와 다르다.
   * 여러 개면 `?status=RECEIVED&status=IN_PROGRESS`.
   */
  @ApiProperty({
    enum: InquiryStatus,
    enumName: 'InquiryStatus',
    isArray: true,
    required: false,
  })
  @IsOptional()
  @Transform(toList)
  @IsEnum(InquiryStatus, { each: true })
  status?: InquiryStatus[];

  /** 제목에 들어 있으면 나온다. */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(200)
  @Matches(NO_NUL, { message: '제목에 쓸 수 없는 문자가 있습니다' })
  title?: string;
}
