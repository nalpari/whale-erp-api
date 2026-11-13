import type { DispatchResult, ProcessResult } from '@prisma/client';
import {
  AFFILIATION_TEMPLATE,
  INVITATION_TEMPLATE,
  sendFailureOf,
} from '../contracts/contract-send-log';

/** 발송 이력의 종류(API 전용 enum). 복귀 확인도 같은 소속 추가 확인 요청 알림톡이라 소속 추가 확인 요청이다 */
export const STAFF_SEND_KIND_LABELS = {
  SIGNUP_INVITE: '가입 초대',
  AFFILIATION_REQUEST: '소속 추가 확인 요청',
  /** 관리자가 직원 상세 [비밀번호 초기화]로 보낸 재설정 링크 메일(WHALEERP-676) */
  PASSWORD_RESET: '비밀번호 초기화',
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

/** 메일 실패 사유로 관리자에게 보이는 문구 — SMTP 원문(받는 주소가 섞인다)은 이력에만 두고 내보내지 않는다 */
export const MAIL_SEND_FAILURE_MESSAGE =
  '메일을 보내지 못했습니다. 잠시 뒤 비밀번호 초기화를 다시 눌러 주세요';

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

/** 메일 발송 이력(mail_send_logs) 중 직원 상세에 싣는 칸 */
export type MailLogRow = {
  mailId: number;
  result: ProcessResult;
  sentAt: Date;
};

export type SendLog = {
  /** 알림톡 줄은 alimtalk_send_logs.alimtalk_send_log_id, 메일 줄(PASSWORD_RESET)은 mail_send_logs.mail_id — 두 테이블의 번호는 겹칠 수 있어 kind 와 함께 본다 */
  sendLogId: number;
  /** 알림톡 줄은 보낸 계약, 메일 줄은 계약과 무관해 null */
  contractId: number | null;
  kind: StaffSendKind;
  isResend: boolean;
  result: StaffSendResult;
  failureReason: string | null;
  retryable: boolean | null;
  sentAt: Date;
};

/**
 * 알림톡 발송 이력(오래된 순)을 직원 상세 발송 이력(최근 순)으로 바꾼다. 재발송은 같은 계약으로 앞서 직원에게 나갔을 수 있는(성공 ·
 * 접수 여부 모름) 발송이 있을 때다 — 확실히 나가지 않은 실패(거절 · 보내기 전 실패)는 세지 않는다. 직원이 받은 기준이라 계약의
 * 재발송 횟수(resendCount)와는 다를 수 있다 — 보낸 계약이 되돌리기로 임시저장이 된 뒤 다시 보내면 resendCount 는 세지 않지만 직원은
 * 앞 초대를 받았고, 이력 행이 빠졌거나(AlimtalkService.record 는 INSERT 실패를 삼킨다) 앱으로 나간 발송(판별값 없는 옛 계약)은 이력에 없다.
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

/** 비밀번호 초기화 메일 이력 한 줄. 계약과 무관하고 다시 보내기 판정이 없다(isResend false · retryable null) */
function toMailSendLog(row: MailLogRow): SendLog {
  const failed = row.result !== 'SUCCEEDED';
  return {
    sendLogId: row.mailId,
    contractId: null,
    kind: 'PASSWORD_RESET',
    isResend: false,
    result: failed ? 'FAILED' : 'SUCCEEDED',
    failureReason: failed ? MAIL_SEND_FAILURE_MESSAGE : null,
    retryable: null,
    sentAt: row.sentAt,
  };
}

/** 알림톡 줄과 메일 줄 모두를 보낸 시각 최근 순으로 다시 정렬한다. 시각이 같으면 넘겨받은 순서를 지킨다 — 알림톡 줄이 앞이다(안정 정렬) */
export function mergeSendLogs(
  talkLogs: readonly SendLog[],
  mailRows: readonly MailLogRow[],
): SendLog[] {
  return [...talkLogs, ...mailRows.map(toMailSendLog)].sort(
    (a, b) => b.sentAt.getTime() - a.sentAt.getTime(),
  );
}
