import { ApiProperty } from '@nestjs/swagger';
import { NoticeType, PostContentType } from '@prisma/client';

/**
 * 사용자에게 보이는 공지사항 · FAQ. 목록과 상세가 같은 모양이다 — FAQ 목록은 펼쳐 읽으므로 본문을 싣는다.
 * 노출 대상 · 게시 상태 · 수정자는 운영자 화면의 것이라 싣지 않는다.
 */
export class PublishedPostResponseDto {
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

/** 공지사항 상세의 이전 · 다음 글. */
export class PostNeighborDto {
  postId: number;
  title: string;
  /** 게시일(YYYY-MM-DD). */
  postedDate: string;
}

export class PostNeighborsDto {
  /** 목록에서 바로 아래 — 더 오래된 공지사항. 없으면 null. */
  prev: PostNeighborDto | null;
  /** 목록에서 바로 위 — 더 새 공지사항. 없으면 null. */
  next: PostNeighborDto | null;
}

/**
 * 고객지원 상세(#282). 공지사항이면 이전 · 다음을 함께 준다. FAQ 는 펼쳐 읽어 상세 이동이 없어 늘 null 이다.
 */
export class SupportPostResponseDto extends PublishedPostResponseDto {
  /** 목록에서 바로 아래 — 더 오래된 공지사항. 없거나 FAQ 면 null. */
  prev: PostNeighborDto | null;
  /** 목록에서 바로 위 — 더 새 공지사항. 없거나 FAQ 면 null. */
  next: PostNeighborDto | null;
}

export class PublishedPostListResponseDto {
  items: PublishedPostResponseDto[];
  total: number;
}
