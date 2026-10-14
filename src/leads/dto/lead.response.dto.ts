import { ApiProperty } from '@nestjs/swagger';
import { InquiryStatus, LeadInterest } from '@prisma/client';

/** 커뮤니티 관리 도입문의 목록의 한 줄. */
export class LeadListItemDto {
  leadId: number;
  /** 문의자 이름 */
  contactName: string;
  phone: string;
  /** 업종(공통코드 INDUSTRY 값) */
  industryCode: string;
  /** 업종 직접 입력 — 업종이 기타일 때 */
  industryDetail: string | null;
  @ApiProperty({ enum: LeadInterest, enumName: 'LeadInterest', isArray: true })
  interests: LeadInterest[];
  @ApiProperty({ enum: InquiryStatus, enumName: 'InquiryStatus' })
  status: InquiryStatus;
  /** 접수 일시 */
  createdAt: Date;
}

export class LeadListResponseDto {
  items: LeadListItemDto[];
  total: number;
}

/**
 * 커뮤니티 관리 도입문의 상세(운영 정책 CNT-12 — 이름 · 업종 · 전화번호 · 이메일 · 관심 서비스 · 도입 예정 시기 ·
 * 동의 여부). 답변 · 내부 메모를 저장할 때 이 `updatedAt` 을 그대로 보낸다. 처리중 전환은 본문이 없다.
 */
export class LeadResponseDto extends LeadListItemDto {
  email: string;
  /** 도입 예정 시기(공통코드 값) */
  planPeriodCode: string | null;
  /** 문의 내용 */
  body: string;
  /** 개인정보 동의 일시 — 필수라 늘 있다 */
  privacyAgreedAt: Date;
  /** 마케팅 수신 동의 일시. 동의하지 않았으면 null. */
  marketingAgreedAt: Date | null;
  /** 처리중으로 바꾼 시각. 아직 접수 상태이거나, 처리중을 거치지 않고 답변했으면 null. */
  processingStartedAt: Date | null;
  processingStartedBy: number | null;
  processingStartedByName: string | null;
  /** 문의자에게 보낸 답변 */
  reply: string | null;
  repliedAt: Date | null;
  repliedBy: number | null;
  repliedByName: string | null;
  /** 운영자 내부 메모. 문의자에게 보이지 않는다. */
  internalMemo: string | null;
  /** 상담 완료일(YYYY-MM-DD) — 이날부터 1년 뒤 파기 */
  consultedDate: string | null;
  /** 최근 수정 일시 */
  updatedAt: Date;
}
