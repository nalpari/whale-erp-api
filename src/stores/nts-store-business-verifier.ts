import { NtsBusinessClient } from '../nts/nts-business.client';
import type {
  BusinessIdentity,
  StoreBusinessVerifier,
} from './store-business-verifier';

/**
 * 점포의 진위확인을 회원가입과 같은 국세청 클라이언트로 한다. 값의 모양만 바꾼다 — 점포는 ceoName · openDate(UTC
 * 자정 Date), 클라이언트는 bizCeoName · bizOpenDate(YYYY-MM-DD). 국세청이 답하지 못하면 클라이언트의
 * NtsUnavailableError 를 그대로 던진다 — 그 메시지에는 요청 값이 없고, 점포 서비스가 503 으로 바꾼다.
 */
export class NtsStoreBusinessVerifier implements StoreBusinessVerifier {
  constructor(private readonly client: NtsBusinessClient) {}

  async verify(identity: BusinessIdentity): Promise<boolean> {
    const result = await this.client.verify({
      bizRegistrationNumber: identity.bizRegistrationNumber,
      bizCeoName: identity.ceoName,
      bizOpenDate: identity.openDate.toISOString().slice(0, 10),
    });
    return result === 'MATCH';
  }
}

/**
 * StoresModule 의 STORE_BUSINESS_VERIFIER. 키가 없으면 null 이다(운영이면 NtsModule 이 기동 때 error 로그를
 * 남긴다) — 클릭마다 「잠시 뒤 다시」 503 과 오류 로그를 내는 대신, 「연동이 없다」 503 으로 설정이 빠진 것을 알린다.
 */
export function storeBusinessVerifierFor(
  client: NtsBusinessClient,
): StoreBusinessVerifier | null {
  return client.isConfigured ? new NtsStoreBusinessVerifier(client) : null;
}
