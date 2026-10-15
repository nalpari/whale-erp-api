import {
  NtsBusinessClient,
  NtsUnavailableError,
} from '../nts/nts-business.client';
import { NtsStoreBusinessVerifier } from './nts-store-business-verifier';

const identity = {
  bizRegistrationNumber: '1234567890',
  ceoName: '정하윤',
  openDate: new Date(Date.UTC(2020, 2, 2)),
};

const clientReturning = (verify: jest.Mock) =>
  ({ verify }) as unknown as NtsBusinessClient;

describe('NtsStoreBusinessVerifier', () => {
  it('점포의 세 값을 국세청 클라이언트 모양(bizCeoName · YYYY-MM-DD)으로 넘긴다', async () => {
    const verify = jest.fn().mockResolvedValue('MATCH');
    await new NtsStoreBusinessVerifier(clientReturning(verify)).verify(
      identity,
    );

    expect(verify).toHaveBeenCalledWith({
      bizRegistrationNumber: '1234567890',
      bizCeoName: '정하윤',
      bizOpenDate: '2020-03-02',
    });
  });

  it('MATCH 는 true, MISMATCH 는 false', async () => {
    await expect(
      new NtsStoreBusinessVerifier(
        clientReturning(jest.fn().mockResolvedValue('MATCH')),
      ).verify(identity),
    ).resolves.toBe(true);
    await expect(
      new NtsStoreBusinessVerifier(
        clientReturning(jest.fn().mockResolvedValue('MISMATCH')),
      ).verify(identity),
    ).resolves.toBe(false);
  });

  it('국세청이 답하지 못하면 그대로 던진다 — 점포 서비스가 503 으로 바꾼다', async () => {
    const error = new NtsUnavailableError('국세청 응답 HTTP 500');
    await expect(
      new NtsStoreBusinessVerifier(
        clientReturning(jest.fn().mockRejectedValue(error)),
      ).verify(identity),
    ).rejects.toBe(error);
  });
});
