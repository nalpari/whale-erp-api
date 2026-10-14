import type { InquiryStatus } from '@prisma/client';

/**
 * 커뮤니티 관리 목록의 답변 상태 거르기 (WHALEERP-332). 문의사항 · 도입문의가 같은 `InquiryStatus` 를 쓴다.
 * 「답변 대기」는 접수와 처리중을 합친 것이다(2026-10-12 재영 승인).
 */
export const ANSWER_STATUS_LABELS = {
  WAITING: '답변 대기',
  ANSWERED: '답변 완료',
} as const;

export type AnswerStatus = keyof typeof ANSWER_STATUS_LABELS;

export const ANSWER_STATUSES = Object.keys(
  ANSWER_STATUS_LABELS,
) as AnswerStatus[];

export function statusesOf(answerStatus: AnswerStatus): InquiryStatus[] {
  return answerStatus === 'ANSWERED'
    ? ['ANSWERED']
    : ['RECEIVED', 'IN_PROGRESS'];
}
