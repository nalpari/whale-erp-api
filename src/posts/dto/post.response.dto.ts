import { ApiProperty } from '@nestjs/swagger';
import {
  AttachmentFileType,
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
  /** 최근 수정자 이름. 수정자가 없거나, 계정을 찾을 수 없거나, 이름이 비어 있으면 null. */
  updatedByName: string | null;
}

export class PostListResponseDto {
  items: PostListItemDto[];
  total: number;
}

/**
 * 공지사항 첨부파일 한 개. 내려받기 주소는 싣지 않는다 — 화면을 열어 둔 채 5분이 지나면 만료되므로 첨부마다
 * `…/attachments/:postAttachmentId/download-url` 로 따로 받는다.
 */
export class PostAttachmentDto {
  postAttachmentId: number;
  /** 원래 파일 이름 */
  fileName: string;
  @ApiProperty({ enum: AttachmentFileType, enumName: 'AttachmentFileType' })
  fileType: AttachmentFileType;
  sizeBytes: number;
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
  /** 첨부파일. 올린 순서. FAQ 는 늘 빈 목록이다. */
  attachments: PostAttachmentDto[];
  createdAt: Date;
  /** 최근 수정 일시. 수정할 때 이 값을 그대로 보낸다. */
  updatedAt: Date;
  /** 최근 수정자(관리자 ID) */
  updatedBy: number | null;
  updatedByName: string | null;
}
