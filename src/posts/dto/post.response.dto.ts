import { ApiProperty } from '@nestjs/swagger';
import {
  NoticeType,
  PostAudienceType,
  PostContentType,
  PostStatus,
} from '@prisma/client';

/** 커뮤니티 관리 목록의 한 줄. */
export class PostListItemDto {
  postId: number;
  @ApiProperty({ enum: PostContentType, enumName: 'PostContentType' })
  contentType: PostContentType;
  title: string;
  @ApiProperty({ enum: PostStatus, enumName: 'PostStatus' })
  status: PostStatus;
  @ApiProperty({ enum: NoticeType, enumName: 'NoticeType', nullable: true })
  noticeType: NoticeType | null;
  faqCategoryCode: string | null;
  /** 상단 고정 표시. 관리자 목록은 고정 글을 위로 올리지 않는다 — 최근 수정일 순서 그대로다. */
  isPinned: boolean;
  /** 최근 수정 일시 */
  updatedAt: Date;
  /** 최근 수정자 이름. 이름이 비어 있는 계정이면 null. */
  updatedByName: string | null;
}

export class PostListResponseDto {
  items: PostListItemDto[];
  total: number;
}

/** 공지사항 · FAQ 상세. 수정 화면이 그대로 쓴다. */
export class PostResponseDto {
  postId: number;
  @ApiProperty({ enum: PostContentType, enumName: 'PostContentType' })
  contentType: PostContentType;
  title: string;
  body: string;
  @ApiProperty({ enum: PostStatus, enumName: 'PostStatus' })
  status: PostStatus;
  @ApiProperty({ enum: NoticeType, enumName: 'NoticeType', nullable: true })
  noticeType: NoticeType | null;
  isPinned: boolean;
  /** 게시 시작일(YYYY-MM-DD) */
  publishStartDate: string | null;
  /** 게시 종료일(YYYY-MM-DD) */
  publishEndDate: string | null;
  faqCategoryCode: string | null;
  @ApiProperty({
    enum: PostAudienceType,
    enumName: 'PostAudienceType',
    isArray: true,
  })
  audiences: PostAudienceType[];
  createdAt: Date;
  /** 최근 수정 일시. 수정할 때 이 값을 그대로 보낸다. */
  updatedAt: Date;
  /** 최근 수정자(관리자 ID) */
  updatedBy: number | null;
  updatedByName: string | null;
}
