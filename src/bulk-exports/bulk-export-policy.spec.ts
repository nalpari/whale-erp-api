import {
  bulkExportFileName,
  isVisibleTo,
  resolveStoreIds,
  safeName,
  scopeKeyOf,
  targetStaffWhere,
} from './bulk-export-policy';

const direct = {
  storeId: 1,
  storeTypeCode: 'DIRECT',
  storeStatusCode: 'OPERATING',
};
const franchise = {
  storeId: 2,
  storeTypeCode: 'FRANCHISE',
  storeStatusCode: 'OPERATING',
};
const closedFranchise = {
  storeId: 3,
  storeTypeCode: 'FRANCHISE',
  storeStatusCode: 'CLOSED',
};
const closedDirect = {
  storeId: 4,
  storeTypeCode: 'DIRECT',
  storeStatusCode: 'CLOSED',
};
// 2026-10-29 10:00 한국 = 01:00 UTC
const NOW = new Date('2026-10-29T01:00:00.000Z');
const CONSENTED = { account: { is: { isHqSharingConsented: true } } };

describe('targetStaffWhere — 담을 직원', () => {
  const tail = [
    { contracts: { some: { status: { not: 'DRAFT' } } } },
    {
      OR: [
        { employmentStatus: 'EMPLOYED' },
        {
          employmentStatus: 'RETIRED',
          retiredDate: { gte: new Date('2023-10-29T00:00:00.000Z') },
        },
      ],
    },
  ];

  it('가맹마스터는 범위 점포의 임시저장 아닌 계약이 있는 재직자 · 3년 안 퇴직자 — 동의 · 폐점으로 가리지 않는다', () => {
    expect(targetStaffWhere('FM', [franchise, closedFranchise], NOW)).toEqual({
      AND: [{ storeId: { in: [2, 3] } }, ...tail],
    });
  });

  it('BP 마스터는 가맹 점포에서 본사 제공 동의한 직원만, 폐점한 가맹 점포 직원은 모두 뺀다 — 폐점 직영은 담는다', () => {
    expect(
      targetStaffWhere(
        'BM',
        [direct, franchise, closedFranchise, closedDirect],
        NOW,
      ),
    ).toEqual({
      AND: [
        {
          OR: [
            { storeId: { in: [1, 4] } },
            { storeId: { in: [2] }, ...CONSENTED },
          ],
        },
        ...tail,
      ],
    });
  });

  it('퇴직 3년은 한국 날짜로 센다 — 한국 0시~9시에도 전날로 밀리지 않는다', () => {
    // 2026-10-29 00:30 한국 = 2026-10-28 15:30 UTC
    const where = targetStaffWhere(
      'FM',
      [franchise],
      new Date('2026-10-28T15:30:00.000Z'),
    );
    expect(JSON.stringify(where)).toContain('2023-10-29T00:00:00.000Z');
  });

  it('윤년 2월 29일의 3년 전은 2월 28일이다', () => {
    const where = targetStaffWhere(
      'FM',
      [franchise],
      new Date('2028-02-29T03:00:00.000Z'),
    );
    expect(JSON.stringify(where)).toContain('2025-02-28T00:00:00.000Z');
  });

  it('점포가 없으면 아무도 담지 않는다(빈 in)', () => {
    expect(targetStaffWhere('BM', [], NOW).AND?.[0]).toEqual({
      storeId: { in: [] },
    });
  });
});

describe('resolveStoreIds — 요청 범위', () => {
  it('비면 관리하는 점포 전부, 오름차순', () => {
    expect(resolveStoreIds(undefined, [5, 2, 9])).toEqual([2, 5, 9]);
    expect(resolveStoreIds([], [5, 2])).toEqual([2, 5]);
  });

  it('고른 점포를 겹침 없이 오름차순으로', () => {
    expect(resolveStoreIds([9, 2, 9], [2, 5, 9])).toEqual([2, 9]);
  });

  it('관리하지 않는 점포가 하나라도 섞이면 null', () => {
    expect(resolveStoreIds([2, 7], [2, 5])).toBeNull();
  });
});

describe('scopeKeyOf', () => {
  it('{권한 유형}:{점포} — 같은 BP 안에서 만드는 중 하나만 두는 키', () => {
    expect(scopeKeyOf('BM', [2, 5, 9])).toBe('BM:2,5,9');
  });
});

describe('isVisibleTo — 목록 · 내려받기', () => {
  const row = { bpCodeId: 7, roleTypeCode: 'BM', storeIds: [2, 5] };
  const viewer = (over: object = {}) => ({
    bpCodeId: 7,
    roleTypeCode: 'BM',
    storeIds: [1, 2, 5],
    ...over,
  });

  it('같은 BP · 같은 권한 유형이고 요청의 점포를 모두 관리하면 본다 — 요청한 사람이 아니어도', () => {
    expect(isVisibleTo(row, viewer())).toBe(true);
  });

  it('다른 BP 는 보지 않는다', () => {
    expect(isVisibleTo(row, viewer({ bpCodeId: 8 }))).toBe(false);
  });

  it('권한 유형이 다르면 보지 않는다 — 가맹마스터 파일(동의로 가리지 않음)이 BP 마스터에게 보이지 않게', () => {
    expect(
      isVisibleTo(
        { ...row, roleTypeCode: 'FM' },
        viewer({ roleTypeCode: 'BM' }),
      ),
    ).toBe(false);
  });

  it('요청의 점포 하나라도 관리하지 않으면 보지 않는다', () => {
    expect(isVisibleTo(row, viewer({ storeIds: [2] }))).toBe(false);
  });
});

describe('bulkExportFileName', () => {
  it('직원자료_{BP명}_{한국 날짜}.zip — 파일 이름에 못 쓰는 글자는 밑줄', () => {
    expect(
      bulkExportFileName('웨일/커피', new Date('2026-10-28T16:00:00.000Z')),
    ).toBe('직원자료_웨일_커피_20261029.zip');
  });
});

describe('safeName — zip 안 경로 조각', () => {
  it.each(['.', '..', '...'])(
    '점만 있는 이름(%s)은 밑줄 — 위 폴더로 빠져나가지 못하게(zip-slip)',
    (name) => {
      expect(safeName(name)).toBe('_');
    },
  );

  it('점이 섞인 보통 이름은 그대로', () => {
    expect(safeName('김.하람')).toBe('김.하람');
    expect(safeName('a/../b')).toBe('a_.._b');
  });
});
