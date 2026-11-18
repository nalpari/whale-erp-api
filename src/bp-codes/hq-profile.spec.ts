import { Logger } from '@nestjs/common';
import { hqBizOf, liveHqStoreId, tradeNameOf } from './hq-profile';

// BP 상호명 · 사업자정보는 본사 점포에 있다(2026-11-17). 본사가 없으면 불변식이 깨진 것이라 조용히 넘기지 않고 로그를 남긴다.
describe('hq-profile', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => error.mockRestore());

  it('본사 상호명을 읽는다', () => {
    expect(
      tradeNameOf({
        stores: [{ businessProfile: { bizTradeName: '고래상사' } }],
      }),
    ).toBe('고래상사');
    expect(error).not.toHaveBeenCalled();
  });

  it('본사 · 사업자정보가 없으면 빈 이름을 주되 error 로그를 남긴다 — 빈 상호명이 알림 · 파일명으로 조용히 나가지 않게 알아챈다', () => {
    expect(tradeNameOf({ stores: [] }, 7)).toBe('');
    expect(tradeNameOf({ stores: [{ businessProfile: null }] }, 8)).toBe('');
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('bpCodeId=7'));
  });

  it('hqBizOf 도 본사가 없으면 error 로그를 남긴다', () => {
    expect(hqBizOf({ stores: [] }).tradeName).toBe('');
    expect(error).toHaveBeenCalled();
  });

  it('살아 있는 본사만 본사 id 로 준다 — 지워진 본사만 남은 BP 를 수정 대상으로 잡지 않는다', () => {
    expect(liveHqStoreId({ stores: [{ storeId: 3, isDeleted: false }] })).toBe(
      3,
    );
    expect(
      liveHqStoreId({ stores: [{ storeId: 3, isDeleted: true }] }),
    ).toBeNull();
    expect(liveHqStoreId({ stores: [] })).toBeNull();
  });
});
