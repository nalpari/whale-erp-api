import { ApiProperty } from '@nestjs/swagger';
import { NoticeType, PostContentType } from '@prisma/client';

/**
 * 사용자에게 보이는 공지사항 · FAQ. 목록과 상세가 같은 모양이다 — FAQ 목록은 펼쳐 읽으므로 본문을 싣는다.
 * 노출 대상 · 게시 상태 · 수정자는 운영자 화면의 것이라 싣지 않는다.
 */
export class PublishedPostDto {
  postId: number;
  @ApiProperty({ enum: PostContentType, enumName: 'PostContentType' })
  contentType: PostContentType;
  title: string;
  /** 평문. 화면은 HTML 로 그리지 않고 이스케이프해 보인다. */
  body: string;
  @ApiProperty({ enum: NoticeType, enumName: 'NoticeType', nullable: true })
  noticeType: NoticeType | null;
  faqCategoryCode: string | null;
  /** 상단 고정. 목록은 고정 글을 먼저 준다. */
  isPinned: boolean;
  /** 게시일(YYYY-MM-DD) — 게시 시작일, 없으면 등록 일시의 한국 날짜. */
  postedDate: string;
}

export class PublishedPostListResponseDto {
  items: PublishedPostDto[];
  total: number;
}
