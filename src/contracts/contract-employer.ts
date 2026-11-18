import { ConflictException, HttpStatus } from '@nestjs/common';

/** 사용자 칸 판정에 읽는 점포 사업자정보 칸 — 대표자 · 사업자등록번호 */
export const EMPLOYER_BIZ_SELECT = {
  bizCeoName: true,
  bizRegistrationNumber: true,
} as const;

/**
 * 사용자 칸이 비었는가 — 대표자 · 사업자등록번호 중 하나라도 없으면(공백만 있어도) 근로계약서를 보내거나 날인하지 않는다.
 * 날인이 그 값을 고정해 처리 완료본에 영영 빈 칸으로 남기 때문이다(본사는 사업자 인증을 풀면 두 값이 비고 미운영이 된다,
 * 2026-11-18 김민식). 발송 · 날인 · 직원 앱 상세가 모두 이 판정을 쓴다.
 */
export const employerMissing = (
  biz: {
    bizCeoName: string | null;
    bizRegistrationNumber: string | null;
  } | null,
): boolean => !biz?.bizCeoName?.trim() || !biz.bizRegistrationNumber?.trim();

/** 사용자 칸이 비어 막을 때의 409 — 관리자(발송)와 직원(날인)에게 다른 문장을 보인다 */
export const employerMissingConflict = (message: string) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'EMPLOYER_INFO_MISSING',
    message,
  });
