import { storeLabelOf } from './store-label';

describe('storeLabelOf', () => {
  it('본사 점포는 「[본사] 상호」, 매장은 이름 그대로(WHALEERP-750)', () => {
    expect(storeLabelOf({ name: '도레미커피', isHq: true })).toBe(
      '[본사] 도레미커피',
    );
    expect(storeLabelOf({ name: '도레미커피 신촌점', isHq: false })).toBe(
      '도레미커피 신촌점',
    );
  });
});
