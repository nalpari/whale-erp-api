import type { ExcelDeliveryMethod, ExcelDownloadStatus } from '@prisma/client';
import { kstDateTime } from '../common/kst-date-time';

/** 바로 받는 엑셀의 상한. 이 건수부터 예약 생성이다(S-BAYAJS · BP-1). */
export const EXCEL_DIRECT_MAX_ROWS = 10_000;
/** 같은 사람 · 같은 화면이 다시 요청하기까지 기다리는 시간. */
export const EXCEL_REQUEST_INTERVAL_MS = 60_000;
/** 예약 생성한 파일을 내려받을 수 있는 시간 — 완료부터. 지나면 매일 정리 배치가 S3 에서도 지운다. */
export const EXCEL_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 정리 배치가 S3 파일을 지우는 대상 — 만료된 지 이 기간 안인 것. 지운 표시를 따로 두지 않아 매일 같은 범위를 다시 지우므로
 * (S3 삭제는 없는 키에도 성공) 배치가 며칠 멈췄다 돌아와도 놓치지 않을 만큼 넉넉히 두되, 2년치를 매일 훑지는 않는다.
 */
export const EXCEL_FILE_SWEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 예약 생성 시도 횟수 — 첫 시도가 실패하면 한 번 다시 하고, 그래도 실패면 실패 메일을 보낸다. */
export const EXCEL_MAX_ATTEMPTS = 2;
/** 다운로드 이력 보존 — 2년(사용자 결정, 2026-10-28. 개인정보 접속기록 보관 기준). */
export const EXCEL_LOG_RETENTION_YEARS = 2;

type LatestRequest = { status: ExcelDownloadStatus; requestedAt: Date };

export type Admission =
  { kind: 'ok' } | { kind: 'busy' } | { kind: 'wait'; seconds: number };

/**
 * 새 요청을 받을지 — 같은 사람 · 같은 화면의 마지막 요청으로 판단한다. 생성 중이면 시간과 관계없이 막고(정책 「생성 중에는
 * 새 요청을 받지 않는다」), 아니면 1분에 한 번이다. 실패한 요청도 센다 — 다시 눌러 같은 일을 거듭 하지 않게.
 */
export function admissionOf(
  latest: LatestRequest | null,
  now: Date,
): Admission {
  if (!latest) return { kind: 'ok' };
  if (latest.status === 'PENDING' || latest.status === 'PROCESSING')
    return { kind: 'busy' };
  const left =
    latest.requestedAt.getTime() + EXCEL_REQUEST_INTERVAL_MS - now.getTime();
  return left > 0
    ? { kind: 'wait', seconds: Math.ceil(left / 1000) }
    : { kind: 'ok' };
}

export function deliveryMethodOf(rowCount: number): ExcelDeliveryMethod {
  return rowCount >= EXCEL_DIRECT_MAX_ROWS ? 'SCHEDULED' : 'DIRECT';
}

/** 예약 생성이 실패한 뒤 상태 — 시도 횟수가 남았으면 다시 대기, 아니면 실패. */
export function afterFailure(attemptCount: number): 'PENDING' | 'FAILED' {
  return attemptCount < EXCEL_MAX_ATTEMPTS ? 'PENDING' : 'FAILED';
}

/** EMAIL_EXCEL_READY 변수. 링크는 관리자 웹 화면이다 — 로그인한 본인만 api 에서 파일 주소를 받는다. */
export function readyMailVariables(input: {
  screenName: string;
  rowCount: number;
  expiresAt: Date;
  link: string;
}): Record<string, string> {
  return {
    화면: input.screenName,
    건수: input.rowCount.toLocaleString('ko-KR'),
    만료일시: kstDateTime(input.expiresAt),
    링크: input.link,
  };
}

/** EMAIL_EXCEL_FAILED 변수. */
export function failedMailVariables(input: {
  screenName: string;
  requestedAt: Date;
}): Record<string, string> {
  return { 화면: input.screenName, 요청일시: kstDateTime(input.requestedAt) };
}
