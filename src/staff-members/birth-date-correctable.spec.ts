import { isBirthDateCorrectable } from './birth-date-correctable';

describe('isBirthDateCorrectable', () => {
  // 한국 2026-10-26 12:00
  const now = new Date('2026-10-26T03:00:00Z');
  const date = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const staff = (over: object = {}) => ({
    employmentStatus: 'EMPLOYED' as const,
    retiredDate: null as Date | null,
    account: { status: 'JOINED' },
    ...over,
  });

  it.each([
    ['가입 완료 재직', staff(), true],
    [
      '퇴직일 내일(퇴직 예정)',
      staff({ retiredDate: date('2026-10-27') }),
      true,
    ],
    [
      '퇴직일 오늘(오늘까지 재직)',
      staff({ retiredDate: date('2026-10-26') }),
      true,
    ],
    ['계정 없음', staff({ account: null }), false],
    ['탈퇴 계정', staff({ account: { status: 'WITHDRAWN' } }), false],
    ['연결 보류 계정', staff({ account: { status: 'LINK_HOLD' } }), false],
    ['퇴직(RETIRED)', staff({ employmentStatus: 'RETIRED' }), false],
    [
      '퇴직일 어제인데 배치 전(EMPLOYED)',
      staff({ retiredDate: date('2026-10-25') }),
      false,
    ],
  ])('%s → %p', (_name, row, expected) => {
    expect(isBirthDateCorrectable(row, now)).toBe(expected);
  });

  it('한국 0~9시(UTC 로는 전날)는 한국 날짜로 본다', () => {
    // UTC 2026-10-25 15:30 = 한국 10-26 00:30. 퇴직일 10-25 는 한국으로는 이미 어제다.
    const earlyKst = new Date('2026-10-25T15:30:00Z');
    expect(
      isBirthDateCorrectable(
        staff({ retiredDate: date('2026-10-25') }),
        earlyKst,
      ),
    ).toBe(false);
    expect(
      isBirthDateCorrectable(
        staff({ retiredDate: date('2026-10-26') }),
        earlyKst,
      ),
    ).toBe(true);
  });
});
