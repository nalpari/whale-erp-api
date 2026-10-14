import { ApiProperty } from '@nestjs/swagger';
import { AttachmentFileType, InquiryStatus } from '@prisma/client';

/** 커뮤니티 관리 문의사항 목록의 한 줄. 「보낸 곳」은 BP 이름 · 점포 이름 · 보낸 사람 이름으로 화면이 잇는다. */
export class InquiryListItemDto {
  inquiryId: number;
  title: string;
  /** 문의 유형(공통코드 값) */
  inquiryCategoryCode: string;
  @ApiProperty({ enum: InquiryStatus, enumName: 'InquiryStatus' })
  status: InquiryStatus;
  /** 접수 일시 */
  createdAt: Date;
  /** BP 이름(상호). BP 를 찾을 수 없으면 null. */
  bpName: string | null;
  /** 점포 이름. 점포 대상 문의가 아니거나 점포를 찾을 수 없으면 null. */
  storeName: string | null;
  /** 보낸 사람(등록한 관리자) 이름. 계정을 찾을 수 없거나 이름이 비어 있으면 null. */
  senderName: string | null;
}

export class InquiryListResponseDto {
  items: InquiryListItemDto[];
  total: number;
}

/** 답변 이력의 한 줄. 답변을 고치면 새 줄이 더해진다 — 마지막 줄이 지금 답변이다. */
export class InquiryReplyDto {
  inquiryReplyId: number;
  body: string;
  repliedAt: Date;
  repliedBy: number;
  repliedByName: string | null;
}

/** 첨부파일 정보. 내려받기는 첨부파일 저장소(WHALEERP-587)가 생기면 따로 연다. */
export class InquiryAttachmentDto {
  inquiryAttachmentId: number;
  fileName: string;
  @ApiProperty({ enum: AttachmentFileType, enumName: 'AttachmentFileType' })
  fileType: AttachmentFileType;
  sizeBytes: number;
}

/** 커뮤니티 관리 문의사항 상세. 처리중 · 답변 · 메모를 저장할 때 이 `updatedAt` 을 그대로 보낸다. */
export class InquiryResponseDto extends InquiryListItemDto {
  body: string;
  /** 보낸 사람(등록한 관리자) ID */
  createdBy: number;
  /** 보낸 사람의 권한 유형(공통코드 ROLE_TYPE). 계정을 찾을 수 없으면 null. */
  senderRoleTypeCode: string | null;
  /** 처리중으로 바꾼 시각 — 처리 이력의 「확인」 줄. 처리중을 거치지 않고 답변했으면 null. */
  processingStartedAt: Date | null;
  processingStartedBy: number | null;
  processingStartedByName: string | null;
  /** 답변 이력. 오래된 것부터. */
  replies: InquiryReplyDto[];
  /** 첨부파일. 순서대로. */
  attachments: InquiryAttachmentDto[];
  /** 운영자 내부 메모. 문의자에게 보이지 않는다. */
  internalMemo: string | null;
  /** 최근 수정 일시 */
  updatedAt: Date;
}
