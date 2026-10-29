import { hqVisibleWhere } from './hq-visible';
import { HQ_SHARING_CONSENTED } from './hq-sharing';

describe('hqVisibleWhere (본사 역할에게 보이는 개인 단위 자료 — 근로계약 목록 · 로그인 후 홈 공용)', () => {
  const typeOf = new Map([
    [1, { storeTypeCode: 'DIRECT', storeStatusCode: 'OPERATING' }],
    [2, { storeTypeCode: 'FRANCHISE', storeStatusCode: 'OPERATING' }],
    [3, { storeTypeCode: 'FRANCHISE', storeStatusCode: 'CLOSED' }],
    [4, { storeTypeCode: 'DIRECT', storeStatusCode: 'CLOSED' }],
  ]);
  const consented = {
    account: HQ_SHARING_CONSENTED.account,
  };

  it('본사 역할은 가려지는 점포(직영이 아님)에서 본사 제공 동의한 직원 것만', () => {
    expect(hqVisibleWhere('BA', [1, 2], typeOf)).toEqual({
      contract: {
        OR: [
          { storeId: { in: [1] } },
          { storeId: { in: [2] }, staffMember: consented },
        ],
      },
      staff: {
        OR: [{ storeId: { in: [1] } }, { storeId: { in: [2] }, ...consented }],
      },
    });
  });

  it('폐점한 가맹 점포는 동의한 직원 것도 빠진다 — 폐점한 직영 점포는 그대로 보인다(ATT-30 v227)', () => {
    expect(hqVisibleWhere('BM', [1, 2, 3, 4], typeOf)).toEqual({
      contract: {
        OR: [
          { storeId: { in: [1, 4] } },
          { storeId: { in: [2] }, staffMember: consented },
        ],
      },
      staff: {
        OR: [
          { storeId: { in: [1, 4] } },
          { storeId: { in: [2] }, ...consented },
        ],
      },
    });
    expect(hqVisibleWhere('BM', [1, 3], typeOf)).toEqual({
      contract: { storeId: { in: [1] } },
      staff: { storeId: { in: [1] } },
    });
  });

  it('가려지는 점포가 없으면 점포 조건뿐', () => {
    expect(hqVisibleWhere('FM', [1, 2], typeOf)).toEqual({
      contract: { storeId: { in: [1, 2] } },
      staff: { storeId: { in: [1, 2] } },
    });
  });
});
