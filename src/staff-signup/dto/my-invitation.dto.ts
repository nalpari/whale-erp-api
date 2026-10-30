import { ApiProperty } from '@nestjs/swagger';
import { EmploymentType } from '@prisma/client';
import { IsBoolean, IsOptional } from 'class-validator';
import { IsHqSharingConsentVersion } from '../hq-sharing-consent';

/**
 * 로그인한 직원에게 온 가입 초대 하나(WHALEERP-603, 2026-10-28) — 계정의 휴대전화번호로 나간, 아직 쓸 수 있는 가입 초대 ·
 * 재초대. 앱은 이 목록에서 골라 근무지를 더한다(초대 코드 · 링크를 넣지 않는다).
 */
export class MyInvitationDto {
  /** 초대 — 더하기(`POST /me/invitations/{invitationId}/accept`)의 경로 값 */
  invitationId: number;

  /** 초대한 근무지(점포) 이름 */
  storeName: string;

  /** 고용 형태 — 정직원 · 파트타이머 */
  // enumName 을 주면 다른 DTO 의 EmploymentType 스키마와 설명을 나눠 써 한쪽 설명이 덮인다 — 여기서는 펼쳐 둔다
  @ApiProperty({ enum: EmploymentType })
  employmentType: EmploymentType;

  /** 직무 — 함께 온 계약의 값(없으면 직원 레코드), 고용 형태와 같은 곳에서 읽는다. 계약에 직무가 없는 옛 행이면 null 일 수 있다 */
  @ApiProperty({ nullable: true, type: String })
  jobTitle: string | null;

  /** 초대를 보낸 시각 */
  sentAt: Date;

  /** 초대가 끝나는 시각(보낸 때부터 30일) */
  expiresAt: Date;

  /** 본사 제공 동의를 물을지 — 직영이 아닌 점포이고 계정이 아직 동의하지 않았다(운영 정책 ATT-30) */
  asksHqSharingConsent: boolean;
}

export class MyInvitationListResponseDto {
  /** 보낸 시각 최근 순 */
  items: MyInvitationDto[];

  /** items 의 개수 */
  total: number;
}

/** 근무지 더하기 — 본사 제공 동의 */
export class AcceptMyInvitationDto {
  /**
   * 본사 제공 동의(운영 정책 ATT-30, 선택). 목록의 asksHqSharingConsent 가 true 일 때만 쓴다 — 직영 점포이거나 계정이
   * 받아 주는 문구 버전에 이미 동의했으면 보내도 바꾸지 않는다. 더는 받아 주지 않는 버전에 동의했으면 true 로 지금 버전에
   * 다시 동의한다. 동의는 계정에 하나다(api #78)
   */
  @IsOptional()
  @IsBoolean()
  hqSharingConsented?: boolean;

  /**
   * 본사 제공 동의 문구 버전 — 화면이 보인 문구의 버전(예: v1.0, ATT-30 v252). hqSharingConsented 가 true 일 때
   * 싣는다(실었으면 비지 않은 64자 이하 문자열 — 아니면 400), 아니면 보지 않는다. 빠지거나(null 포함) 지금 버전과 다르면 근무지 더하기는 그대로
   * 마치고 동의만 남기지 않는다 — 응답의 hqSharingConsentRecorded 가 false 다(예전 앱 · 배포 어긋남에도 막지 않는다, v253)
   */
  @IsHqSharingConsentVersion()
  hqSharingConsentVersion?: string;
}

/** 더한 근무지 — 앱이 그 소속의 날인 대기 근로계약서로 간다 */
export class AcceptMyInvitationResponseDto {
  /** 이 계정에 이어진 직원 레코드 */
  staffMemberId: number;

  /** 근무지(점포) — 이은 직원 레코드의 점포. 앱이 `/me/contracts` 항목을 이 storeId 로 걸러 그 근무지 근로계약서만 연다 */
  storeId: number;

  /** 근무지(점포) 이름 */
  storeName: string;

  /**
   * 본사 제공 동의를 남겼는지(ATT-30 v253). true 남김 · false 동의했지만 보인 문구 버전이 지금과 다르거나 싣지 않아(예전 앱) 남기지 않음(계정의 동의는
   * 그대로 — 앱은 내 정보에서 다시 동의하라고 알린다) · null 남길 동의가 없음(묻지 않는 초대 · 이미 동의함 · 동의하지 않음)
   */
  @ApiProperty({ nullable: true, type: Boolean })
  hqSharingConsentRecorded: boolean | null;
}
