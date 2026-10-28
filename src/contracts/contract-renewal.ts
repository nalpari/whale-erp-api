import { ContractStatus } from '@prisma/client';
import { addDays, kstToday } from '../staff-members/kst-date';

/**
 * 갱신 예정 — 계약 종료일 며칠 전부터인가. 갱신 예정 알림 배치(WHALEERP-152)와 직원 요약 · 근로계약 목록의 갱신 예정일이 함께
 * 쓴다(관리자 웹 직원 목록 · 상세의 RENEWAL_NOTICE_DAYS 와도 같다).
 */
export const RENEWAL_NOTICE_DAYS = 30;

/**
 * 갱신 예정일 — 체결 완료이고 종료일이 오늘(한국 날짜) 이후인 계약의 종료일 30일 전. 종료일이 지난 체결 완료는 종료 배치 전의
 * 잠깐이라 내지 않는다. 종료일이 30일 안이면 이미 지난 날짜다.
 */
export function renewalDateOf(
  c: { status: ContractStatus | null; endDate: Date | null },
  now = new Date(),
): Date | null {
  if (c.status !== 'SIGNED' || c.endDate === null) return null;
  if (c.endDate < kstToday(now)) return null;
  return addDays(c.endDate, -RENEWAL_NOTICE_DAYS);
}
