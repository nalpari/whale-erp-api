import { ApiProperty, PickType } from '@nestjs/swagger';
import { NoticeType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListPostsDto } from './list-posts.dto';

/** 고객지원 · 비로그인 홈의 공지사항 · FAQ 목록(글 종류는 경로로 가른다). 게시 상태 필터는 없다 — 게시된 글만 준다. */
export class ListPublishedPostsDto extends PickType(ListPostsDto, [
  'page',
  'pageSize',
] as const) {
  /** 공지사항 구분으로 거른다. FAQ 에는 쓰지 않는다. */
  @ApiProperty({ enum: NoticeType, enumName: 'NoticeType', required: false })
  @IsOptional()
  @IsEnum(NoticeType)
  noticeType?: NoticeType;

  /** FAQ 카테고리(공통코드 FAQ_CATEGORY 상세코드)로 거른다. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  faqCategoryCode?: string;

  /** 제목(FAQ 는 제목 또는 본문)에 든 글자로 찾는다. 대소문자는 가리지 않는다. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;
}
