import { ApiProperty } from '@nestjs/swagger';
import { PreferenceCategory } from '@prisma/client';
import { IsBoolean } from 'class-validator';

/** 알림을 눌러 열 곳의 종류 — 근무스케줄(달력) · TO-DO · 근로계약 · 급여명세서 */
export const STAFF_NOTIFICATION_TARGET_TYPES = [
  'WORK_SCHEDULE',
  'TODO',
  'CONTRACT',
  'PAYSLIP',
] as const;

/**
 * 알림을 눌러 열 곳. staffMemberId 는 그 업무가 속한 내 소속 — 앱이 현재 근무지를 맞춘 뒤 연다. 급여명세서는 근무지와
 * 상관없어(PAY-8) 없다. 종류에 따라 workDate(근무스케줄, 근무일 YYYY-MM-DD) · todoId(TO-DO) · contractId(근로계약) ·
 * payslipId(급여명세서) 중 하나가 있다.
 */
export class StaffNotificationTargetDto {
  @ApiProperty({
    enum: STAFF_NOTIFICATION_TARGET_TYPES,
    enumName: 'StaffNotificationTargetType',
  })
  type: (typeof STAFF_NOTIFICATION_TARGET_TYPES)[number];
  /** 그 업무가 속한 내 소속. 급여명세서는 없다 */
  staffMemberId?: number;
  /** 근무스케줄 — 근무일 YYYY-MM-DD */
  workDate?: string;
  /** TO-DO */
  todoId?: number;
  /** 근로계약 */
  contractId?: number;
  /** 급여명세서 */
  payslipId?: number;
}

/** 직원 알림 한 줄. 받는 사람별 행이라 id 는 notification_recipient_id 다 */
export class MyNotificationItemDto {
  /** 알림 ID(받는 사람별). 읽음 바꾸기에 쓴다 */
  id: number;
  /** 만들 때 쓴 템플릿 코드(PUSH_*) */
  templateCode: string;
  /** 수신 설정 묶음 — 지금 템플릿의 값. 템플릿이 없으면 null */
  @ApiProperty({
    enum: PreferenceCategory,
    enumName: 'PreferenceCategory',
    nullable: true,
  })
  category: PreferenceCategory | null;
  /** 제목 — 만들 때의 문구 */
  title: string;
  /** 둘째 줄 — 만들 때의 문구 */
  body: string;
  /** 긴급 TO-DO 의 수행 임박 알림 — 빨간 점 */
  isUrgent: boolean;
  isRead: boolean;
  createdAt: Date;
  /** 눌러 열 곳. 관련 업무가 지워졌거나 내 재직 소속으로 닿을 수 없으면 null — 「열 수 없습니다」 */
  @ApiProperty({ type: StaffNotificationTargetDto, nullable: true })
  target: StaffNotificationTargetDto | null;
}

export class MyNotificationListResponseDto {
  /** 만든 지 14일 안, 새것부터 */
  items: MyNotificationItemDto[];
  total: number;
  /** 14일 안의 미확인 건수 — 종 배지 */
  unreadCount: number;
}

export class MyNotificationPreferenceDto {
  @ApiProperty({ enum: PreferenceCategory, enumName: 'PreferenceCategory' })
  category: PreferenceCategory;
  /** 앱 푸시 받기. 꺼도 알림함에는 남는다 */
  isEnabled: boolean;
}

export class MyNotificationPreferenceListResponseDto {
  /** 네 묶음 — 근로계약서 · 근무스케줄 · TO-DO · 급여명세서 */
  items: MyNotificationPreferenceDto[];
}

export class UpdateMyNotificationPreferenceDto {
  /** 앱 푸시 받기 */
  @IsBoolean()
  isEnabled: boolean;
}
