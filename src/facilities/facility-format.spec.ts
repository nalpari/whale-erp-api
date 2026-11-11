import {
  documentKindOf,
  FACILITY_DOCUMENT_KINDS,
  pickLabel,
  totalAmountOf,
} from './facility-format';

describe('facility-format', () => {
  describe('totalAmountOf — 총금액은 단가 × 수량(정책서 PL-5)', () => {
    it('단가 × 수량', () => {
      expect(totalAmountOf(10_000_000, 2)).toBe(20_000_000);
    });

    it('단가가 없으면 총금액도 없다', () => {
      expect(totalAmountOf(null, 3)).toBeNull();
    });

    it('단가 0 은 0 원이다 — 비어 있는 것과 다르다', () => {
      expect(totalAmountOf(0, 5)).toBe(0);
    });

    it('최대 단가 × 최대 수량도 정확하다(안전한 정수 범위)', () => {
      expect(totalAmountOf(9_999_999_999, 9_999)).toBe(99_989_999_990_001);
      expect(Number.isSafeInteger(totalAmountOf(9_999_999_999, 9_999))).toBe(
        true,
      );
    });
  });

  describe('documentKindOf — 경로의 문서 종류', () => {
    it.each(FACILITY_DOCUMENT_KINDS)('%s 는 그대로', (kind) => {
      expect(documentKindOf(kind)).toBe(kind);
    });

    it.each(['', 'user_manual', 'toString', 'INVOICE'])(
      '%p 는 문서 종류가 아니다',
      (raw) => {
        expect(documentKindOf(raw)).toBeNull();
      },
    );
  });

  describe('pickLabel — 점포 BP 의 행을 먼저, 없으면 플랫폼 원본', () => {
    const rows = [
      { itemCode: 'GRINDER', bpCode: 'BP000000', label: '그라인더' },
      { itemCode: 'GRINDER', bpCode: 'BP000017', label: '원두 그라인더' },
      { itemCode: 'ICE_MAKER', bpCode: 'BP000000', label: '제빙기' },
    ];

    it('BP 가 고친 이름이 있으면 그것', () => {
      expect(pickLabel(rows, 'GRINDER', 'BP000017')).toBe('원두 그라인더');
    });

    it('BP 행이 없으면 플랫폼 원본 이름', () => {
      expect(pickLabel(rows, 'ICE_MAKER', 'BP000017')).toBe('제빙기');
    });

    it('어디에도 없으면 코드 그대로', () => {
      expect(pickLabel(rows, 'GONE', 'BP000017')).toBe('GONE');
    });
  });
});
