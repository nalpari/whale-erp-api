import { ApiProperty } from '@nestjs/swagger';
import { EmploymentType } from '@prisma/client';

/**
 * 초대 확인 결과(진입 · 가입 화면 가이드 ②). 근무지 · 고용 형태 · 유효 기간만 보인다 — 직원 레코드 값(이름 ·
 * 생년월일 등)과 기존 계정 정보는 주지 않는다.
 */
export class InvitationCheckResponseDto {
  /** 초대한 근무지(점포) 이름 */
  storeName: string;

  /**
   * 고용 형태 — 정직원 · 파트타이머. 함께 온 계약(발송 대기)의 값이고, 계약 칸이 비었으면 직원 레코드 값이다(직원 레코드는
   * 체결을 거친 계약이 시작할 때 옮긴다)
   */
  // enumName 을 주면 다른 DTO 의 EmploymentType 스키마와 설명을 나눠 써 한쪽 설명이 덮인다 — 여기서는 펼쳐 둔다
  @ApiProperty({ enum: EmploymentType })
  employmentType: EmploymentType;

  /** 초대가 끝나는 시각(보낸 때부터 30일) */
  expiresAt: Date;

  /** 가입 화면이 채울 휴대전화번호(읽기 전용) — 초대(근로계약서)의 번호 */
  phone: string;

  /** 본사 제공 동의를 물을지 — 직영이 아닌 점포이고 아직 동의하지 않았다(운영 정책 ATT-30) */
  asksHqSharingConsent: boolean;
}
