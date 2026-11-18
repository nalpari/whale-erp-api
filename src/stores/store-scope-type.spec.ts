import { canSeeHq, matchesStoreScope } from './store-scope-type';

// 상단 점포 범위의 유형 — 직영 · 가맹 · 본사(2026-11-17). 본사 점포는 직영(DIRECT)이지만 「직영」 범위에서는 빠진다.
describe('matchesStoreScope', () => {
  const direct = { storeTypeCode: 'DIRECT', isHq: false };
  const franchise = { storeTypeCode: 'FRANCHISE', isHq: false };
  const hq = { storeTypeCode: 'DIRECT', isHq: true };

  it('유형을 주지 않으면(전체) 모두 맞는다 — 본사 포함', () => {
    for (const s of [direct, franchise, hq])
      expect(matchesStoreScope(s, undefined)).toBe(true);
  });

  it('DIRECT 는 본사가 아닌 직영만', () => {
    expect(matchesStoreScope(direct, ['DIRECT'])).toBe(true);
    expect(matchesStoreScope(hq, ['DIRECT'])).toBe(false);
    expect(matchesStoreScope(franchise, ['DIRECT'])).toBe(false);
  });

  it('HQ 는 본사만, FRANCHISE 는 가맹만', () => {
    expect(matchesStoreScope(hq, ['HQ'])).toBe(true);
    expect(matchesStoreScope(direct, ['HQ'])).toBe(false);
    expect(matchesStoreScope(franchise, ['FRANCHISE'])).toBe(true);
    expect(matchesStoreScope(hq, ['FRANCHISE'])).toBe(false);
  });

  it('여러 유형은 OR', () => {
    expect(matchesStoreScope(hq, ['DIRECT', 'HQ'])).toBe(true);
  });

  it('isHq 를 모르는 행(옛 호출)은 본사가 아닌 것으로 본다', () => {
    expect(matchesStoreScope({ storeTypeCode: 'DIRECT' }, ['DIRECT'])).toBe(
      true,
    );
  });
});

describe('canSeeHq — 본사는 가맹 계정만 빼고 권한 · 매칭대로(2026-11-17)', () => {
  it.each([
    ['BM', false, true],
    ['BA', false, true],
    ['FM', false, false],
    ['FA', false, false],
    ['PM', true, true],
    ['PA', true, true],
  ])('%s(플랫폼 %s) → %s', (role, isPlatform, expected) => {
    expect(canSeeHq(role, isPlatform)).toBe(expected);
  });
});
