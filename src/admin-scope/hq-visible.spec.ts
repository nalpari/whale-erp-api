import { hqVisibleWhere } from './hq-visible';

describe('hqVisibleWhere (본사 역할에게 보이는 개인 단위 자료 — 근로계약 목록 · 로그인 후 홈 공용)', () => {
  const typeOf = new Map([
    [1, 'DIRECT'],
    [2, 'FRANCHISE'],
  ]);
  const consented = { account: { is: { isHqSharingConsented: true } } };

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

  it('가려지는 점포가 없으면 점포 조건뿐', () => {
    expect(hqVisibleWhere('FM', [1, 2], typeOf)).toEqual({
      contract: { storeId: { in: [1, 2] } },
      staff: { storeId: { in: [1, 2] } },
    });
  });
});
