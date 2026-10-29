import { BizppurioError } from '../alimtalk/bizppurio.client';
import { failureHeadOf } from '../alimtalk/failure-reason';
import {
  sendFailureKindOf,
  sendFailureKindOfReason,
  sendFailureOf,
} from './contract-send-log';

// AlimtalkService.send 가 남기는 failure_reason 그대로 — 머리(failureHeadOf) + `: 메시지`
const reasonOf = (e: unknown) =>
  `${failureHeadOf(e instanceof BizppurioError ? e : null)}: ${e instanceof Error ? e.message : String(e)}`;
const bizppurio = (
  message: string,
  code: number | undefined,
  http: number | undefined,
  path: string,
) => new BizppurioError(message, code, http, { path });

describe('sendFailureKindOf — 발송(dispatch)이 되돌릴지 · 502 문구를 정하는 갈래(비즈뿌리오 오류)', () => {
  it.each([
    ['토큰 단계', { path: '/v1/token' }, 'NOT_SENT'],
    [
      '토큰 단계 계정 오류(코드 있음)',
      { code: 3001, path: '/v1/token' },
      'NOT_SENT',
    ],
    ['메시지 거절', { code: 3018, path: '/v3/message' }, 'REJECTED'],
    ['메시지 요청 뒤 끊김', { path: '/v3/message' }, 'UNCONFIRMED'],
  ] as const)('%s → %s', (_, e, kind) => {
    expect(sendFailureKindOf(e)).toBe(kind);
  });
});

describe('sendFailureOf — 발송 이력의 실패 사유 (WHALEERP-136)', () => {
  it('비즈뿌리오가 코드로 거절하면 실패 · 다시 보낼 수 있음 · 번호를 확인하라는 말', () => {
    const f = sendFailureOf(
      reasonOf(
        bizppurio(
          'sendMessage failed: code=3018 to 01012345678',
          3018,
          200,
          '/v3/message',
        ),
      ),
    );
    expect(f).toMatchObject({ result: 'FAILED', retryable: true });
    expect(f.reason).toContain('코드 3018');
    expect(f.reason).toContain('번호를 확인');
    // 비즈뿌리오 원문(번호가 섞일 수 있다)은 싣지 않는다
    expect(f.reason).not.toContain('01012345678');
  });

  it('토큰 단계는 코드가 있어도 번호 탓이 아니다 — 보내기 전 실패', () => {
    for (const e of [
      bizppurio(
        '/v1/token failed: fetch failed',
        undefined,
        undefined,
        '/v1/token',
      ),
      bizppurio('/v1/token failed: http=401 code=3001', 3001, 401, '/v1/token'),
    ]) {
      const f = sendFailureOf(reasonOf(e));
      expect(f).toMatchObject({ result: 'FAILED', retryable: true });
      expect(f.reason).not.toContain('번호를 확인');
    }
  });

  it('단계를 모르는 실패(비즈뿌리오 오류가 아닌 예외 · 단계 없는 오류)는 접수 여부 모름 — 메시지가 나간 뒤일 수 있다', () => {
    for (const e of [
      new TypeError('boom'),
      new BizppurioError('x', undefined, 200),
    ])
      expect(sendFailureOf(reasonOf(e))).toMatchObject({
        result: 'UNCONFIRMED',
        retryable: false,
      });
  });

  it('path=undefined 로 남은 행은 칸이 없는 것처럼 메시지 머리로 본다 — 토큰 단계 계정 오류가 「번호를 확인」이 되지 않게', () => {
    expect(
      sendFailureKindOfReason(
        'code=3001 http=401 path=undefined: /v1/token failed: http=401 code=3001',
      ).kind,
    ).toBe('NOT_SENT');
  });

  it('메시지 요청 뒤 코드 없는 실패는 접수 여부 모름 — 다시 보내면 두 번 갈 수 있다', () => {
    for (const e of [
      bizppurio(
        '/v3/message failed: aborted (after /v1/token ok)',
        undefined,
        undefined,
        '/v3/message',
      ),
      bizppurio(
        '/v3/message failed: http=502 code=undefined',
        undefined,
        502,
        '/v3/message',
      ),
    ])
      expect(sendFailureOf(reasonOf(e))).toMatchObject({
        result: 'UNCONFIRMED',
        retryable: false,
      });
  });

  it('path 칸이 없는 옛 행은 메시지 머리로 토큰 단계를 본다', () => {
    expect(
      sendFailureKindOfReason(
        'code=undefined http=undefined: /v1/token failed: x',
      ).kind,
    ).toBe('NOT_SENT');
    expect(
      sendFailureKindOfReason('code=3018 http=200: sendMessage failed').kind,
    ).toBe('REJECTED');
    expect(
      sendFailureKindOfReason(
        'code=undefined http=undefined: /v3/message failed: aborted (after /v1/token ok)',
      ).kind,
    ).toBe('UNCONFIRMED');
  });

  it('사유가 비었거나 모양을 모르면 접수 여부 모름 — 다시 보내도 된다고 잘못 말하지 않는다', () => {
    for (const r of [null, '', 'unexpected'])
      expect(sendFailureOf(r)).toMatchObject({
        result: 'UNCONFIRMED',
        retryable: false,
      });
  });
});
