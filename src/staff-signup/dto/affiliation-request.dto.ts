import { ApiProperty } from '@nestjs/swagger';
import { EmploymentType } from '@prisma/client';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * 소속 추가 확인 요청 하나(WHALEERP-130 · 144). 직원 앱이 로그인 뒤 팝업 · 나의 정보 - 소속 점포 · 요청 화면에 보인다. 근무지 ·
 * 사업자 · 고용 형태만 준다 — 관리자가 넣은 직원 레코드 값(이름 · 생년월일 등)은 주지 않는다(초대 확인과 같다).
 */
export class AffiliationRequestDto {
  /** 요청(초대) ID — 수락 · 거절 경로에 쓴다 */
  invitationId: number;

  /** 소속 추가 확인(처음 일하는 점포) · 복귀 확인(그 점포에서 퇴직했던 직원). 화면 용어는 둘 다 「소속 추가 확인 요청」 */
  @ApiProperty({ enum: ['AFFILIATION_CONFIRM', 'RETURN_CONFIRM'] })
  invitationType: 'AFFILIATION_CONFIRM' | 'RETURN_CONFIRM';

  /** 요청한 근무지(점포) 이름 */
  storeName: string;

  /** 그 점포의 사업자(BP) 상호 */
  bpName: string;

  /**
   * 고용 형태 — 정직원 · 파트타이머. 함께 온 계약의 값(없으면 직원 레코드)이다 — 레코드는 계약이 시작할 때 바뀌어 복귀 확인이면 옛
   * 조건일 수 있다. 직무와 늘 같은 곳에서 읽는다
   */
  // enumName 을 주면 다른 DTO 의 EmploymentType 스키마와 설명을 나눠 써 한쪽 설명이 덮인다 — 여기서는 펼쳐 둔다
  @ApiProperty({ enum: EmploymentType })
  employmentType: EmploymentType;

  /** 고용 형태 표시 문구(정직원 · 파트타이머) — 팝업 문구에 그대로 쓴다 */
  @ApiProperty({ nullable: true, type: String })
  employmentTypeLabel: string | null;

  /** 직무 — 함께 온 계약의 값(없으면 직원 레코드), 고용 형태와 같은 곳에서 읽는다. 계약에 직무가 없는 옛 행이면 null 일 수 있다 */
  @ApiProperty({ nullable: true, type: String })
  jobTitle: string | null;

  /** 요청을 보낸 때 */
  sentAt: string;

  /** 요청이 끝나는 때(보낸 때부터 30일) — 지나면 목록에서 빠지고 수락 · 거절은 404 AFFILIATION_REQUEST_ENDED */
  expiresAt: string;

  /** 본사 제공 동의를 함께 물을지 — 직영이 아닌 점포이고 아직 동의하지 않았다(운영 정책 ATT-30) */
  asksHqSharingConsent: boolean;
}

/** 수락 — 본사 제공 동의(선택) */
export class AcceptAffiliationRequestDto {
  /**
   * 본사 제공 동의(운영 정책 ATT-30, 선택). 목록의 asksHqSharingConsent 가 true 일 때만 쓴다 — 직영 점포이거나 계정이 이미
   * 동의했으면 보내도 바꾸지 않는다(근무지 더하기와 같다)
   */
  @IsOptional()
  @IsBoolean()
  hqSharingConsented?: boolean;
}

/** 수락 결과 — 앱이 그 소속의 날인 대기 근로계약서로 간다 */
export class AcceptAffiliationResponseDto {
  /** 이 계정에 이어진 직원 레코드 */
  staffMemberId: number;

  /** 근무지(점포) 이름 */
  storeName: string;

  /** 서명 대기로 넘어간 근로계약 — 날인 기한은 수락한 때부터 30일 */
  contractIds: number[];
}
