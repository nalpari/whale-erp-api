import { ApiProperty } from '@nestjs/swagger';
import { PostStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { toList } from '../../common/query-list';

/** 커뮤니티 관리 공지사항 · FAQ 목록(글 종류는 경로로 가른다). 목록 응답 규칙의 page(1부터) · pageSize(기본 20, 최대 200). */
export class ListPostsDto {
  /** 게시 상태로 거른다. 여러 개면 `?status=DRAFT&status=PUBLISHED`. 없으면 전부. */
  @ApiProperty({
    enum: PostStatus,
    enumName: 'PostStatus',
    isArray: true,
    required: false,
  })
  @IsOptional()
  @Transform(toList)
  @IsEnum(PostStatus, { each: true })
  status?: PostStatus[];

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
