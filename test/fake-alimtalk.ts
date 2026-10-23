import type { AlimtalkService } from '../src/alimtalk/alimtalk.service';

/**
 * 실제로 보내지 않는 알림톡(AlimtalkService 자리). 근로계약 저장 · 발송이 가입 초대 알림톡을 보내므로(WHALEERP-136) 계약을 쓰는
 * e2e 는 `.overrideProvider(AlimtalkService).useValue(fakeAlimtalk())` 로 갈아 끼운다(WHALEERP-616). send 는 성공하고 대체 문자
 * 발신번호가 있는 것으로 답한다 — 발송 여부를 보는 테스트는 돌려받은 send 에 단언한다.
 */
export function fakeAlimtalk() {
  return {
    send: jest.fn().mockResolvedValue({ referenceKey: 'e2e' }),
    hasSmsFallback: () => true,
  } satisfies Record<keyof AlimtalkService, unknown>;
}
