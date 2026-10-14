import {
  canTransition,
  floorLabel,
  missingForOperation,
  regionOf,
  retainEndDate,
} from './store-format';

describe('store-format', () => {
  describe('canTransition', () => {
    it.each([
      ['NOT_OPERATING', 'NOT_OPERATING', true],
      ['NOT_OPERATING', 'OPERATING', true],
      ['NOT_OPERATING', 'CLOSED', true],
      ['OPERATING', 'OPERATING', true],
      ['OPERATING', 'CLOSED', true],
      ['OPERATING', 'NOT_OPERATING', false],
      ['CLOSED', 'CLOSED', true],
      ['CLOSED', 'OPERATING', false],
      ['CLOSED', 'NOT_OPERATING', false],
    ])('%s → %s 는 %s', (from, to, allowed) => {
      expect(canTransition(from, to)).toBe(allowed);
    });
  });

  describe('missingForOperation', () => {
    const ready = {
      bizRegistrationNumber: '1234567890',
      latitude: 37.5,
      longitude: 127.0,
      bpAccountStatusCode: 'ACTIVE',
    };

    it('인증 · 좌표 · 사용 중 BP 가 다 있으면 빈 목록', () => {
      expect(missingForOperation(ready)).toEqual([]);
    });

    it('좌표는 0 도 값이다 — 위도 · 경도 중 하나라도 없으면 모자란다', () => {
      expect(
        missingForOperation({ ...ready, latitude: 0, longitude: 0 }),
      ).toEqual([]);
      expect(missingForOperation({ ...ready, longitude: null })).toEqual([
        'COORDINATES',
      ]);
    });

    it('모자란 것을 모두 준다', () => {
      expect(
        missingForOperation({
          bizRegistrationNumber: null,
          latitude: null,
          longitude: null,
          bpAccountStatusCode: 'INACTIVE',
        }),
      ).toEqual(['BUSINESS_VERIFICATION', 'COORDINATES', 'BP_INACTIVE']);
    });
  });

  it('regionOf 는 기본주소의 앞 두 마디, 주소가 없으면 null', () => {
    expect(regionOf('서울특별시 강남구 테헤란로 123')).toBe(
      '서울특별시 강남구',
    );
    expect(regionOf('  세종특별자치시  ')).toBe('세종특별자치시');
    expect(regionOf(null)).toBeNull();
    expect(regionOf(' ')).toBeNull();
  });

  it('retainEndDate 는 한국 날짜 + 5년 — UTC 로는 전날인 한국 오전도 그 날짜로 센다', () => {
    // 2026-10-14 08:00 KST = 2026-10-13T23:00Z
    expect(retainEndDate(new Date('2026-10-13T23:00:00Z'))).toEqual(
      new Date('2031-10-14T00:00:00Z'),
    );
    // 윤일은 그 해 2월 말일로
    expect(retainEndDate(new Date('2028-02-29T03:00:00Z'))).toEqual(
      new Date('2033-02-28T00:00:00Z'),
    );
  });

  it('floorLabel 은 있는 칸만 이어 쓴다', () => {
    expect(
      floorLabel({
        floorTypeCode: 'GROUND',
        floorNumber: 1,
        floorAreaPyeong: '18.0',
        floorAreaSqm: '59.5',
        seatCount: 24,
      }),
    ).toBe('지상 1층 · 18평 · 59.5㎡ · 24석');
    expect(
      floorLabel({
        floorTypeCode: 'BASEMENT',
        floorNumber: null,
        floorAreaPyeong: null,
        floorAreaSqm: null,
        seatCount: 0,
      }),
    ).toBe('지하 · 0석');
  });
});
