import { BizppurioError } from './bizppurio.client';

/** 비즈뿌리오 오류가 아닌 실패(요청 전 검사 등)의 단계 칸 값 */
export const LOCAL_FAILURE_PATH = 'local';

/**
 * alimtalk_send_logs.failure_reason 의 머리 — `code=… http=… path=…`. 뒤에 `: 메시지` 가 붙는다. path 는 실패한 단계(`/v1/token` ·
 * `/v3/message`, 비즈뿌리오 오류가 아니면 local)다. 근로계약 발송 이력이 이 형식으로 실패 갈래를 되읽는다
 * (contracts/contract-send-log.ts sendFailureKindOfReason) — 바꾸면 함께 고친다.
 */
export function failureHeadOf(e: unknown): string {
  if (!(e instanceof BizppurioError))
    return `code=undefined http=undefined path=${LOCAL_FAILURE_PATH}`;
  return `code=${e.code} http=${e.httpStatus} path=${e.path}`;
}
