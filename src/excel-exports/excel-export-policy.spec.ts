import {
  admissionOf,
  deliveryMethodOf,
  EXCEL_DIRECT_MAX_ROWS,
  EXCEL_FILE_TTL_MS,
  EXCEL_MAX_ATTEMPTS,
  EXCEL_REQUEST_INTERVAL_MS,
  failedMailVariables,
  readyMailVariables,
  afterFailure,
} from './excel-export-policy';

const NOW = new Date('2026-10-28T05:00:00.000Z'); // 한국 14:00
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('excel-export-policy', () => {
  it('정책 값 — 1만 건 · 1분 · 24시간 · 두 번까지 시도', () => {
    expect(EXCEL_DIRECT_MAX_ROWS).toBe(10_000);
    expect(EXCEL_REQUEST_INTERVAL_MS).toBe(60_000);
    expect(EXCEL_FILE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(EXCEL_MAX_ATTEMPTS).toBe(2);
  });

  describe('admissionOf — 같은 사람 · 같은 화면의 마지막 요청으로 판단', () => {
    it('처음이거나 1분이 지났으면 받는다', () => {
      expect(admissionOf(null, NOW)).toEqual({ kind: 'ok' });
      expect(
        admissionOf({ status: 'SUCCEEDED', requestedAt: ago(60_000) }, NOW),
      ).toEqual({ kind: 'ok' });
    });

    it('생성 중(대기 · 생성 중)이면 시간과 관계없이 막는다', () => {
      for (const status of ['PENDING', 'PROCESSING'] as const)
        expect(
          admissionOf({ status, requestedAt: ago(10 * 60_000) }, NOW),
        ).toEqual({ kind: 'busy' });
    });

    it('1분 안이면 남은 초를 올림해 알려 준다 — 실패한 요청도 센다', () => {
      expect(
        admissionOf({ status: 'SUCCEEDED', requestedAt: ago(59_001) }, NOW),
      ).toEqual({ kind: 'wait', seconds: 1 });
      expect(
        admissionOf({ status: 'FAILED', requestedAt: ago(1_000) }, NOW),
      ).toEqual({ kind: 'wait', seconds: 59 });
    });
  });

  it('deliveryMethodOf — 1만 건 미만은 바로, 1만 건부터 예약', () => {
    expect(deliveryMethodOf(0)).toBe('DIRECT');
    expect(deliveryMethodOf(9_999)).toBe('DIRECT');
    expect(deliveryMethodOf(10_000)).toBe('SCHEDULED');
  });

  it('afterFailure — 첫 시도 실패는 다시 대기, 두 번째는 실패로 끝낸다', () => {
    expect(afterFailure(1)).toBe('PENDING');
    expect(afterFailure(2)).toBe('FAILED');
    expect(afterFailure(3)).toBe('FAILED');
  });

  it('readyMailVariables — 화면 · 건수(천 단위 쉼표) · 한국 시각 기한 · 관리자 웹 링크', () => {
    expect(
      readyMailVariables({
        screenName: '점포 목록',
        rowCount: 12_480,
        expiresAt: new Date('2026-10-29T05:05:00.000Z'),
        link: 'https://admin.example.com/excel-downloads/7',
      }),
    ).toEqual({
      화면: '점포 목록',
      건수: '12,480',
      만료일시: '2026-10-29 14:05',
      링크: 'https://admin.example.com/excel-downloads/7',
    });
  });

  it('failedMailVariables — 화면 · 한국 시각 요청 일시', () => {
    expect(
      failedMailVariables({
        screenName: 'BP 목록',
        requestedAt: new Date('2026-10-28T05:01:00.000Z'),
      }),
    ).toEqual({ 화면: 'BP 목록', 요청일시: '2026-10-28 14:01' });
  });
});
