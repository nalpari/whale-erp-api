import { ApiProperty } from '@nestjs/swagger';
import { PostContentType, PostStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

/** 커뮤니티 관리 공지사항 · FAQ 목록. 목록 응답 규칙의 page(1부터) · pageSize(기본 20, 최대 200). */
export class ListPostsDto {
  @ApiProperty({ enum: PostContentType, enumName: 'PostContentType' })
  @IsEnum(PostContentType)
  contentType: PostContentType;

  /** 게시 상태로 거른다. 없으면 전부. */
  @ApiProperty({ enum: PostStatus, enumName: 'PostStatus', required: false })
  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;

  /** 쪽 번호. 1부터, 최대 10,000,000 — 건너뛸 행 수가 integer 범위를 넘지 않게. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  page?: number = 1;

  /** 한 쪽 건수. 기본 20, 최대 200. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 20;
}
