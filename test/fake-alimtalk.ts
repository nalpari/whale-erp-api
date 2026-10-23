import type { AlimtalkService } from '../src/alimtalk/alimtalk.service';
import type { BizppurioClient } from '../src/alimtalk/bizppurio.client';

/**
 * 실제로 보내지 않는 알림톡(AlimtalkService 자리). DB 가 없는 e2e(Prisma 를 목으로 바꾼 스위트)는 템플릿을 읽을 수 없어
 * `.overrideProvider(AlimtalkService).useValue(fakeAlimtalk())` 로 통째로 갈아 끼운다(WHALEERP-616). send 는 성공하고 대체 문자
 * 발신번호가 있는 것으로 답한다 — 발송 여부를 보는 테스트는 돌려받은 send 에 단언한다. 실제 DB 를 쓰는 스위트는 fakeBizppurio 를 쓴다.
 */
export function fakeAlimtalk() {
  return {
    send: jest.fn().mockResolvedValue({ referenceKey: 'e2e' }),
    hasSmsFallback: () => true,
  } satisfies Record<keyof AlimtalkService, unknown>;
}

/**
 * 바깥 발송(비즈뿌리오 HTTP)만 가짜로 — 실제 DB 를 쓰는 e2e 가 `.overrideProvider(BizppurioClient).useValue(fakeBizppurio())` 로
 * 갈아 끼운다. AlimtalkService 는 그대로 돌아 알림톡 템플릿(TALK_STAFF_INVITATION)을 DB 에서 읽어 렌더하고 발송 이력을 남긴다 —
 * 마이그레이션이 템플릿 변수를 바꿔 운영 발송이 깨지면 이 스위트도 깨진다(api #141 리뷰). 접수 성공(1000)으로 답한다.
 */
export function fakeBizppurio() {
  return {
    sendMessage: jest.fn().mockResolvedValue({
      code: 1000,
      description: 'success',
      refkey: 'e2e',
      messagekey: 'e2e',
    }),
  } satisfies Record<keyof BizppurioClient, unknown>;
}
