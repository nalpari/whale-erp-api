import type { DispatchResult } from '@prisma/client';
import {
  AFFILIATION_TEMPLATE,
  INVITATION_TEMPLATE,
  sendFailureOf,
} from '../contracts/contract-delivery.service';

/** 발송 이력의 종류(API 전용 enum). 복귀 확인도 같은 소속 추가 확인 요청 알림톡이라 소속 추가 확인 요청이다 */
export const STAFF_SEND_KIND_LABELS = {
  SIGNUP_INVITE: '가입 초대',
  AFFILIATION_REQUEST: '소속 추가 확인 요청',
} as const;
export type StaffSendKind = keyof typeof STAFF_SEND_KIND_LABELS;
export const STAFF_SEND_KINDS = Object.keys(
  STAFF_SEND_KIND_LABELS,
) as readonly StaffSendKind[];

/** 발송 결과(API 전용 enum) — 성공은 비즈뿌리오 접수 기준, 접수 여부 모름은 다시 보내면 두 번 갈 수 있다 */
export const STAFF_SEND_RESULT_LABELS = {
  SUCCEEDED: '성공',
  FAILED: '실패',
  UNCONFIRMED: '접수 여부 모름',
} as const;
export type StaffSendResult = keyof typeof STAFF_SEND_RESULT_LABELS;
export const STAFF_SEND_RESULTS = Object.keys(
  STAFF_SEND_RESULT_LABELS,
) as readonly StaffSendResult[];

/** 발송 이력에 싣는 알림톡 템플릿 — 근로계약 발송(ContractDeliveryService.dispatch)이 보내는 둘 */
export const SEND_KIND_OF_TEMPLATE: Readonly<Record<string, StaffSendKind>> = {
  [INVITATION_TEMPLATE]: 'SIGNUP_INVITE',
  [AFFILIATION_TEMPLATE]: 'AFFILIATION_REQUEST',
};

export type SendLogRow = {
  alimtalkSendLogId: number;
  templateCode: string;
  relatedId: number | null;
  result: DispatchResult;
  failureReason: string | null;
  sentAt: Date;
};

export type SendLog = {
  sendLogId: number;
  contractId: number;
  kind: StaffSendKind;
  isResend: boolean;
  result: StaffSendResult;
  failureReason: string | null;
  retryable: boolean | null;
  sentAt: Date;
};

/**
 * 알림톡 발송 이력(오래된 순)을 직원 상세 발송 이력(최근 순)으로 바꾼다. 재발송은 같은 계약에 앞서 나간(성공 · 접수 여부 모름)
 * 발송이 있을 때다 — 확실히 나가지 않은 실패는 발송을 되돌리므로(계약 발송 일시가 비워진다) 다음 발송은 재발송이 아니다. 계약의
 * 재발송 횟수(resendCount)와 같은 기준이다. 다만 알림톡 이력 기준이라 이력 INSERT 가 빠졌거나(AlimtalkService.record 는 실패를 삼킨다)
 * 앱으로 나간 발송(판별값 없는 옛 계약)이 섞이면 resendCount 와 다를 수 있다.
 */
export function toSendLogs(rows: readonly SendLogRow[]): SendLog[] {
  const delivered = new Set<number>();
  const logs: SendLog[] = [];
  for (const row of rows) {
    const kind = SEND_KIND_OF_TEMPLATE[row.templateCode];
    if (!kind || row.relatedId === null) continue;
    const contractId = row.relatedId;
    const failure =
      row.result === 'SUCCEEDED' ? null : sendFailureOf(row.failureReason);
    logs.push({
      sendLogId: row.alimtalkSendLogId,
      contractId,
      kind,
      isResend: delivered.has(contractId),
      result: failure?.result ?? 'SUCCEEDED',
      failureReason: failure?.reason ?? null,
      retryable: failure?.retryable ?? null,
      sentAt: row.sentAt,
    });
    if (!failure?.retryable) delivered.add(contractId);
  }
  return logs.reverse();
}
