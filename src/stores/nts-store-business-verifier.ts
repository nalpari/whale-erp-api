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
