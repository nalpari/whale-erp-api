import { ApiProperty } from '@nestjs/swagger';

export const PAYSLIP_SEND_FAILURES = [
  'MAIL_NOT_CONFIGURED',
  'APP_URL_NOT_CONFIGURED',
  'NO_EMAIL',
  'CONFLICT',
  'MAIL_FAILED',
  'MASKED',
] as const;
export type PayslipSendFailure = (typeof PAYSLIP_SEND_FAILURES)[number];

export class PayslipSentItemDto {
  payslipId: number;
  staffName: string;
}

export class PayslipSendFailedItemDto {
  /** 가린 명세서(MASKED)는 null */
  payslipId: number | null;
  /** 가린 명세서(MASKED)는 null */
  staffName: string | null;
  /**
   * MAIL_NOT_CONFIGURED 메일 설정 없음 · APP_URL_NOT_CONFIGURED 직원 앱 주소 없음 · NO_EMAIL 직원 앱 계정 없음(가입 전 ·
   * 탈퇴) · CONFLICT 그사이 다른 요청이 고침 · MAIL_FAILED 메일 발송 실패 · MASKED 본사 제공 동의가 없어 이 관리자가 보낼 수 없음
   */
  @ApiProperty({ enum: PAYSLIP_SEND_FAILURES, enumName: 'PayslipSendFailure' })
  reason: PayslipSendFailure;
  /** 화면에 그대로 보일 문장 */
  message: string;
}

/** 일괄 발송 결과. 일부가 실패해도 보낸 것은 그대로다 */
export class PayslipSendResultDto {
  sent: PayslipSentItemDto[];
  failed: PayslipSendFailedItemDto[];
}
