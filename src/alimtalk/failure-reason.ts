// 알림톡 실패 사유(alimtalk_send_logs.failure_reason)의 머리 형식과 비즈뿌리오 단계 이름. import 없는 파일로 둔다 — 근로계약 발송
// 이력(contracts/contract-send-log.ts)이 enum 라벨 경로로도 읽혀 비즈뿌리오 클라이언트를 끌어오지 않게.

/** 비즈뿌리오 단계 — 토큰 발급(실패하면 메시지는 나가지 않았다) · 메시지 요청 */
export const TOKEN_PATH = '/v1/token';
export const MESSAGE_PATH = '/v3/message';

/** 단계를 모르는 실패(비즈뿌리오 오류가 아니거나 단계가 없는 오류)의 단계 칸 값 — 접수 여부를 모르는 쪽으로 읽힌다 */
export const UNKNOWN_FAILURE_PATH = 'unknown';

/**
 * failure_reason 의 머리 — `code=… http=… path=…`. 뒤에 `: 메시지` 가 붙는다. e 는 비즈뿌리오 오류의 code · httpStatus · path,
 * 비즈뿌리오 오류가 아니면 null. 근로계약 발송 이력이 이 형식으로 실패 갈래를 되읽는다(sendFailureKindOfReason) — 바꾸면 함께 고친다.
 */
export function failureHeadOf(
  e: { code?: number; httpStatus?: number; path?: string } | null,
): string {
  return `code=${e?.code} http=${e?.httpStatus} path=${e?.path ?? UNKNOWN_FAILURE_PATH}`;
}
