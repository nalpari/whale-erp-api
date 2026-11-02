// 근로계약 발송 알림톡의 이름표와 실패 판정 — 발송(ContractDeliveryService)과 직원 상세 발송 이력(staff-members/send-logs)이 같이 쓴다.
// 가벼운 모듈로 둔다 — enum 라벨(api-enums)까지 이 파일을 거쳐 오므로 발송 서비스 · 알림톡 모듈을 끌어오지 않게(failure-reason 은 import 없는 파일).
import { TOKEN_PATH } from '../alimtalk/failure-reason';

/** 가입 초대 알림톡 템플릿(근무지 · 초대코드 · 링크=초대 링크). 카카오 템플릿 TALK_STAFF_INVITATION(2026-10-30 등록) */
export const INVITATION_TEMPLATE = 'TALK_STAFF_INVITATION';
/**
 * 소속 추가 확인 요청 알림톡 · 메일(사업자 · 근무지 · 고용형태 · 링크=직원 앱 요청 화면, WHALEERP-130 · 2026-10-26 재영). 카카오
 * 템플릿 WHALE_AFFILIATION_01 은 등록 · 검수 전이라 알림톡이 거절되고 대체 문자로 간다(가입 초대는 2026-10-30 등록). 메일은 계정의 이메일로 —
 * 알림톡과 따로 가고 실패해도 저장을 되돌리지 않는다.
 */
export const AFFILIATION_TEMPLATE = 'TALK_STAFF_AFFILIATION_REQUEST';
export const AFFILIATION_MAIL_TEMPLATE = 'EMAIL_STAFF_AFFILIATION_REQUEST';

/**
 * 가입 초대 · 소속 추가 확인 요청 알림톡의 관련 업무 유형(alimtalk_send_logs.related_type) — 직원 상세 발송 이력이 이 값으로 찾는다.
 * 근로계약 알림(ContractNoticeService)은 'CONTRACT'(대문자)로 남겨 표기가 다르다 — 이미 쌓인 행이 있어 어느 쪽도 바꾸지 않는다.
 * 계약 관련 알림톡을 함께 찾으려면 둘 다 본다.
 */
export const CONTRACT_RELATED_TYPE = 'contract';

/**
 * 알림톡 실패의 갈래. REJECTED 비즈뿌리오가 코드로 거절, NOT_SENT 보내기 전에 실패(토큰 단계), UNCONFIRMED 메시지 요청 뒤 응답이
 * 끊겨 접수 여부를 모름. 앞의 둘은 확실히 나가지 않아 발송을 되돌리고 다시 보낼 수 있다(502 SEND_FAILED), UNCONFIRMED 는 되돌리지
 * 않고 다시 보내면 두 번 갈 수 있다(502 SEND_UNCONFIRMED).
 */
export type SendFailureKind = 'REJECTED' | 'NOT_SENT' | 'UNCONFIRMED';

/**
 * 비즈뿌리오 오류(BizppurioError 의 code · path)의 갈래. 단계를 모르면(path 없음) 코드가 있으면 거절, 없으면 접수 여부 모름이다.
 * 비즈뿌리오 오류가 아닌 예외는 발송(dispatch)이 따로 본다 — 알림톡을 부르기 전 검사(번호 · 템플릿)라 보내기 전 실패다.
 */
export function sendFailureKindOf(e: {
  code?: number;
  path?: string;
}): SendFailureKind {
  if (e.path === TOKEN_PATH) return 'NOT_SENT';
  return e.code !== undefined ? 'REJECTED' : 'UNCONFIRMED';
}

/**
 * alimtalk_send_logs.failure_reason(`code=… http=… path=…: 메시지`, alimtalk/failure-reason.ts)에서 갈래를 되읽는다. 이력 행은
 * 비즈뿌리오 클라이언트를 부른 뒤에만 남으므로, 단계를 모르는 행(path=unknown — 비즈뿌리오 오류가 아닌 예외)은 접수 여부 모름으로
 * 본다(메시지가 나간 뒤 난 예외일 수 있다). path 칸이 없거나 `undefined` 인 옛 행은 메시지 머리(토큰 단계 메시지는 `/v1/token ` 으로
 * 시작한다)로 토큰 단계를 본다. 모양을 모르면 접수 여부 모름 — 다시 보내도 된다고 잘못 말하지 않는 쪽이다.
 */
export function sendFailureKindOfReason(failureReason: string | null): {
  kind: SendFailureKind;
  code?: number;
} {
  const m = /^code=(\S+) http=\S+(?: path=(\S+))?: (.*)$/s.exec(
    failureReason ?? '',
  );
  if (!m) return { kind: 'UNCONFIRMED' };
  const code = /^-?\d+$/.test(m[1]) ? Number(m[1]) : undefined;
  const recorded = m[2] === 'undefined' ? undefined : m[2];
  const path =
    recorded ?? (m[3].startsWith(`${TOKEN_PATH} `) ? TOKEN_PATH : undefined);
  return { kind: sendFailureKindOf({ code, path }), code };
}

export type SendFailure = {
  result: 'FAILED' | 'UNCONFIRMED';
  /** 관리자에게 보일 사유 — 비즈뿌리오 원문(번호가 섞일 수 있다)은 싣지 않는다 */
  reason: string;
  retryable: boolean;
};

/**
 * 발송 이력의 실패 한 줄 — 갈래는 발송(dispatch)이 되돌릴지 · 502 문구를 정할 때와 같은 sendFailureKindOf 다. 번호를 확인하라는 말은
 * 비즈뿌리오가 코드로 거절했을 때만 한다(502 SEND_FAILED 와 같다).
 */
export function sendFailureOf(failureReason: string | null): SendFailure {
  const { kind, code } = sendFailureKindOfReason(failureReason);
  if (kind === 'REJECTED')
    return {
      result: 'FAILED',
      reason: `비즈뿌리오가 받지 않았습니다(코드 ${code}). 번호를 확인하고 다시 보내 주세요`,
      retryable: true,
    };
  if (kind === 'NOT_SENT')
    return {
      result: 'FAILED',
      reason: '보내기 전에 실패해 나가지 않았습니다. 잠시 뒤 다시 보내 주세요',
      retryable: true,
    };
  return {
    result: 'UNCONFIRMED',
    reason:
      '접수됐는지 알 수 없습니다. 직원에게 받았는지 확인한 뒤 다시 보내 주세요 — 다시 보내면 두 번 갈 수 있습니다',
    retryable: false,
  };
}
