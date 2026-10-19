import { ApiProperty } from '@nestjs/swagger';
import { InquiryStatus } from '@prisma/client';
import { InquiryAttachmentDto } from './inquiry.response.dto';

/** 문의 등록 결과. */
export class CreatedSupportInquiryResponseDto {
  inquiryId: number;
}

/** 고객지원 내 문의 목록의 한 줄. */
export class SupportInquiryListItemDto {
  inquiryId: number;
  title: string;
  /** 문의 유형(공통코드 `INQUIRY_CATEGORY` 값) */
  inquiryCategoryCode: string;
  @ApiProperty({ enum: InquiryStatus, enumName: 'InquiryStatus' })
  status: InquiryStatus;
  /** 등록 일시 */
  createdAt: Date;
  /** 처음 답변한 시각. 답변이 없으면 null. */
  repliedAt: Date | null;
}

export class SupportInquiryListResponseDto {
  items: SupportInquiryListItemDto[];
  total: number;
}

/**
 * 문의자에게 보이는 답변 — 마지막 답변 하나뿐이다. 이전 답변과 답변한 · 고친 운영자는 주지 않는다(운영 정책 CNT-17).
 */
export class SupportInquiryReplyDto {
  /** 지금 답변(마지막 답변 행) */
  body: string;
  /** 처음 답변한 시각 */
  repliedAt: Date;
  /** 고친 적이 있으면 마지막으로 고친 시각(「수정됨」), 없으면 null */
  editedAt: Date | null;
}

/** 고객지원 내 문의 상세. 내부 메모 · 처리한 운영자는 싣지 않는다. */
export class SupportInquiryResponseDto extends SupportInquiryListItemDto {
  body: string;
  /** 처리중으로 바뀐 시각 — 진행 이력의 「처리 중」 줄. 처리중을 거치지 않았으면 null. */
  processingStartedAt: Date | null;
  /** 답변. 아직 없으면 null. */
  reply: SupportInquiryReplyDto | null;
  /** 첨부파일. 순서대로. 내려받기는 `GET /support-inquiries/:inquiryId/attachments/:inquiryAttachmentId/download-url`. */
  attachments: InquiryAttachmentDto[];
}
