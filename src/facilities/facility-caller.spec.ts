import { storeScope, type FacilityCaller } from './facility-caller';

describe('storeScope — 시설물·장비가 보는 점포 범위(본사 점포 포함 규칙)', () => {
  const caller = (over: Partial<FacilityCaller>): FacilityCaller => ({
    adminAccountId: 9,
    roleTypeCode: 'BM',
    isPlatform: false,
    isAllStores: true,
    targetBpCodeId: 7,
    targetBpCode: 'BP000007',
    ...over,
  });
  const mapping = {
    adminMappings: { some: { adminAccountId: 9, isDeleted: false } },
  };

  it.each([
    ['FM', true],
    ['FA', true],
    ['FM', false],
    ['FA', false],
  ])(
    '가맹 계정(%s, 전체 점포 %s)은 본사를 뺀다',
    (roleTypeCode, isAllStores) => {
      expect(storeScope(caller({ roleTypeCode, isAllStores }))).toEqual({
        isDeleted: false,
        bpCodeId: 7,
        isHq: false,
        ...(!isAllStores && mapping),
      });
    },
  );

  it.each(['BM', 'BA'])('전체 점포 %s 는 본사 조건이 없다', (roleTypeCode) => {
    const where = storeScope(caller({ roleTypeCode }));
    expect(where).toEqual({ isDeleted: false, bpCodeId: 7 });
    expect(where).not.toHaveProperty('isHq');
  });

  it('플랫폼 계정은 본사 조건도 매핑도 없다', () => {
    const where = storeScope(
      caller({ roleTypeCode: 'PM', isPlatform: true, isAllStores: false }),
    );
    expect(where).toEqual({ isDeleted: false, bpCodeId: 7 });
  });

  it('전체 점포가 아닌 BA 는 매핑 조건만 남고 본사 조건은 없다 — 본사도 매핑대로', () => {
    const where = storeScope(
      caller({ roleTypeCode: 'BA', isAllStores: false }),
    );
    expect(where).toEqual({ isDeleted: false, bpCodeId: 7, ...mapping });
    expect(where).not.toHaveProperty('isHq');
  });
});
